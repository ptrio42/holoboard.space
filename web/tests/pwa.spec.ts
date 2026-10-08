import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { matchFilter } from "nostr-tools/filter";
import { PNG } from "pngjs";
import jsQR from "jsqr";

test.use({ serviceWorkers: "allow" });

const legacyDist = process.env.HOLOBOARD_LEGACY_DIST;
const currentDist = resolve(process.env.HOLOBOARD_CURRENT_DIST ?? "dist");
const rollbackDist = process.env.HOLOBOARD_ROLLBACK_DIST;
const readerDist = process.env.HOLOBOARD_READER_DIST;
const types: Record<string, string> = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };

async function stopServer(server: ReturnType<typeof createServer>) {
    if (!server.listening) return;
    await new Promise<void>((done, reject) => {
        server.close(error => error ? reject(error) : done());
        server.closeAllConnections();
    });
}

for (const readerRelease of [false, true]) test(readerRelease
    ? "read-only PWA update and code rollback preserve the original invoice"
    : "previous frontend works with current API and PWA updates preserve prepared invoices", async ({ context, page }) => {
    const previous = readerRelease ? rollbackDist : legacyDist;
    const candidate = readerRelease ? readerDist : currentDist;
    test.skip(!previous || !candidate, readerRelease
        ? "Set HOLOBOARD_ROLLBACK_DIST and HOLOBOARD_READER_DIST to local-mock production builds."
        : "Set HOLOBOARD_LEGACY_DIST to a built previous frontend; build the current frontend with the local mock relay.");
    test.setTimeout(readerRelease ? 120000 : 90000);
    let version: "legacy" | "current" = "legacy";
    let workerRevision = 1;
    const server = createServer(async (req, res) => {
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        res.setHeader("Cache-Control", "no-store");
        if (/^\/(api|relay|\.well-known)(\/|$)/.test(path)) {
            res.writeHead(418, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "API navigation reached the server" }));
            return;
        }
        const directory = version === "legacy" ? previous! : candidate!;
        const file = path === "/" || !extname(path) ? "/index.html" : path;
        const target = resolve(directory, `.${file}`);
        if (!target.startsWith(resolve(directory) + "/")) { res.writeHead(403); res.end(); return; }
        try {
            let content = await readFile(target);
            if (file === "/sw.js") content = Buffer.from(`${content.toString()}\n// Isolated test worker revision ${workerRevision}\n`);
            res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
            res.end(content);
        } catch { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    const origin = `http://127.0.0.1:${address.port}`;
    const note = finalizeEvent({ kind: 1, created_at: 1700000000, tags: [], content: "PWA compatibility test note" }, generateSecretKey());
    const entry = { event: note, id: note.id, rank: 1, sats_paid: 210, weight: 200, first_paid_at: 1700000000, last_paid_at: 1700000000, hot_sats: 21, author_share: 0 };
    const requests: Record<string, unknown>[] = [];
    const copiedInvoices: string[] = [];
    const statusRequests: { hash: string | null; note: string | null; method: string | undefined; accept: string | undefined }[] = [];
    const errors: string[] = [];
    const writeFrames: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const apiServer = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        res.setHeader("Cache-Control", "no-store");
        if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
        let data: unknown;
        if (url.pathname === "/api/board") data = { entries: [entry], posts: 1, total_sats: 210, updated_at: 1700000000 };
        else if (url.pathname === "/api/board/waiting-updates") data = { count: 0, note_ids: [], checked_at: Date.now() };
        else if (url.pathname === "/api/board/campaigns") data = { entries: [entry], targets: [entry], total: 1, active_posts: 1, total_sats: 210, has_more: false };
        else if (url.pathname === "/api/promote/preview") data = { event: note, active: true, sats_paid: 210, weight: 200, rank: 1, author_share: 0, billboard_fee_sats: 100, images: [] };
        else if (url.pathname === "/api/support") data = { available: false, author: note.pubkey, reason_code: "no_address", min_sats: 0, max_sats: 0, allows_nostr: false };
        else if (url.pathname === "/api/promote/status") {
            statusRequests.push({ hash: url.searchParams.get("payment_hash"), note: url.searchParams.get("note"), method: req.method, accept: req.headers.accept });
            data = { settled: false, pending: true, sats_paid: 210 };
        }
        else if (url.pathname === "/api/promote") {
            const chunks = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
            requests.push(body);
            data = { invoice: `lnbc-compatibility-${requests.length}`, payment_hash: String(requests.length).repeat(64), amount_sats: body.amount_sats, note_id: note.id, expires_at: Math.floor(Date.now()/1000)+3600, promotion_sats: body.amount_sats, billboard_fee_sats: 0 };
        } else { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
    });
    await new Promise<void>((done) => apiServer.listen(0, "127.0.0.1", done));
    const apiAddress = apiServer.address();
    if (!apiAddress || typeof apiAddress === "string") throw new Error("No mock API server address");
    const apiOrigin = `http://127.0.0.1:${apiAddress.port}`;
    await context.exposeFunction("testCopyInvoice", (invoice: string) => { copiedInvoices.push(invoice); });
    await context.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText: (invoice: string) => (window as unknown as { testCopyInvoice(value: string): Promise<void> }).testCopyInvoice(invoice) },
        });
    });
    // Use real cross-origin HTTP for CORS and service-worker checks. Redirect
    // only the configured test API to a private per-test mock server.
    await context.addInitScript((target) => {
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
            const original = input instanceof Request ? input.url : String(input);
            const url = new URL(original, window.location.href);
            if (url.origin !== "http://127.0.0.1:3334") return nativeFetch(input, init);
            const destination = `${target}${url.pathname}${url.search}${url.hash}`;
            return nativeFetch(input instanceof Request ? new Request(destination, input) : destination, init);
        };
    }, apiOrigin);
    await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        return url.origin === origin || url.origin === apiOrigin ? route.continue() : route.abort();
    });
    const updateWorker = async () => {
        await page.evaluate(async () => {
            const registration = await navigator.serviceWorker.getRegistration();
            if (!registration) throw new Error("Missing service worker");
            const changed = new Promise<void>((done) => navigator.serviceWorker.addEventListener("controllerchange", () => done(), { once: true }));
            await registration.update();
            await changed;
        });
        // The generated registration activates updates without reloading the
        // open page; the next navigation loads the new cached application.
        await page.reload();
    };
    await context.routeWebSocket("**/*", (socket) => {
        if (!socket.url().startsWith("ws://127.0.0.1:3334")) { socket.close(); return; }
        socket.onMessage((message) => {
            const request = JSON.parse(String(message));
            if (request[0] === "CLOSE") return;
            if (request[0] !== "REQ") { writeFrames.push(String(request[0])); return; }
            if (request.slice(2).some((filter: Parameters<typeof matchFilter>[0]) => matchFilter(filter, note))) socket.send(JSON.stringify(["EVENT", request[1], note]));
            socket.send(JSON.stringify(["EOSE", request[1]]));
        });
    });
    try {
        await page.goto(origin);
        await page.waitForFunction(() => !!navigator.serviceWorker.controller);
        if (readerRelease) await expect(page.getByRole("link", { name: "Discussion", exact: true })).toHaveCount(0);
        await page.getByRole("button", { name: "Boost", exact: true }).first().click();
        await page.getByRole("button", { name: readerRelease ? "Boost 210 sats" : "Get invoice, 210 sats", exact: true }).click();
        await expect(page.getByRole("link", { name: readerRelease ? "Open in wallet" : "Open in a wallet", exact: true })).toHaveAttribute("href", "lightning:lnbc-compatibility-1");
        expect(requests[0].amount_sats).toBe(210);
        if (!readerRelease) expect(requests[0]).not.toHaveProperty("author_share");
        const baselineKey = await page.evaluate(() => sessionStorage.getItem("holoboard-last-payment"));
        const baselinePayment = baselineKey ? await page.evaluate(key => sessionStorage.getItem(key), baselineKey) : null;
        const retained = readerRelease ? await context.newPage() : undefined;
        if (retained) {
            retained.on("pageerror", error => errors.push(error.message));
            await retained.addInitScript(({ key, payment }) => {
                sessionStorage.setItem("holoboard-last-payment", key!);
                sessionStorage.setItem(key!, payment!);
            }, { key: baselineKey, payment: baselinePayment });
            await retained.goto(origin);
            await retained.waitForFunction(() => !!navigator.serviceWorker.controller);
            await retained.evaluate(() => {
                Object.assign(window, { retainedDocument: true, workerChanges: 0 });
                navigator.serviceWorker.addEventListener("controllerchange", () => {
                    const state = window as unknown as { workerChanges: number };
                    state.workerChanges++;
                });
            });
        }
        version = "current";
        await updateWorker();
        await expect(page.getByRole("link", { name: "Waiting room", exact: true })).toBeVisible({ timeout: 30000 });
        if (readerRelease) {
            // Activation claims other open tabs without reloading their code.
            await retained!.waitForFunction(() => (window as unknown as { workerChanges: number }).workerChanges > 0);
            expect(await retained!.evaluate(() => (window as unknown as { retainedDocument: boolean }).retainedDocument)).toBe(true);
            await expect(retained!.getByRole("link", { name: "Discussion", exact: true })).toHaveCount(0);
            await retained!.getByRole("button", { name: "Boost", exact: true }).first().click();
            await expect(retained!.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", "lightning:lnbc-compatibility-1");
            await expect(retained!.getByRole("img", { name: "Holoboard visibility invoice QR code" })).toBeVisible();
            expect(requests).toHaveLength(1);
            await retained!.close();
            await expect(page.getByRole("link", { name: "Discussion", exact: true })).toBeVisible();
            await page.goto(`${origin}/discussion/${note.id}`);
            await expect(page.getByRole("article", { name: "Discussion focus", exact: true })).toContainText(note.content);
            await expect(page.getByRole("button", { name: "Reply", exact: true })).toHaveCount(0);
            await page.goto(`${origin}/profile/${note.pubkey}`);
            await expect(page.getByRole("region", { name: "Author profile", exact: true })).toBeVisible();
            await expect(page.getByRole("button", { name: /Connect Nostr|Nostr signer/ })).toHaveCount(0);
            // Playwright 1.63 WebKit rejects even literal worker responses under
            // setOffline: https://github.com/microsoft/playwright/issues/42775.
            // Stop both real servers to test unavailability in every browser.
            await stopServer(server);
            await stopServer(apiServer);
            const unavailable = await page.goto(`${origin}/discussion/${note.id}`);
            expect(unavailable?.status()).toBe(200);
            expect(unavailable?.fromServiceWorker()).toBe(true);
            await expect(page.getByRole("region", { name: "Discussion coverage", exact: true })).toBeVisible();
            expect(await page.evaluate(() => fetch("/api/release-unavailability-probe").then(() => false, () => true))).toBe(true);
            await new Promise<void>(done => server.listen(address.port, "127.0.0.1", done));
            await new Promise<void>(done => apiServer.listen(apiAddress.port, "127.0.0.1", done));
            await page.goto(origin);
            expect(baselineKey).toBeTruthy();
            expect(await page.evaluate(key => sessionStorage.getItem(key!), baselineKey)).toBe(baselinePayment);
        }
        await page.getByRole("button", { name: "Boost", exact: true }).first().click();
        if (!readerRelease) await page.getByRole("button", { name: "Boost 210 sats", exact: true }).click();
        const invoiceNumber = readerRelease ? 1 : 2;
        const invoice = `lnbc-compatibility-${invoiceNumber}`;
        const hash = String(invoiceNumber).repeat(64);
        await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", `lightning:${invoice}`);
        await expect.poll(() => statusRequests.some((request) => request.hash === hash && request.note === note.id && request.method === "GET" && request.accept === "application/json")).toBe(true);
        const saved = await page.evaluate(() => sessionStorage.getItem("holoboard-last-payment"));
        expect(saved).toBeTruthy();
        const before = await page.evaluate((key) => sessionStorage.getItem(key!), saved);
        const checksBeforeUpdate = statusRequests.filter((request) => request.hash === hash).length;
        workerRevision++;
        await updateWorker();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await page.getByRole("button", { name: "Boost", exact: true }).first().click();
        await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", `lightning:${invoice}`);
        expect(await page.evaluate((key) => sessionStorage.getItem(key!), saved)).toBe(before);
        expect(requests).toHaveLength(invoiceNumber);
        await expect.poll(() => statusRequests.filter((request) => request.hash === hash && request.note === note.id).length).toBeGreaterThan(checksBeforeUpdate);
        if (readerRelease) {
            version = "legacy";
            await updateWorker();
            await expect(page.getByRole("link", { name: "Discussion", exact: true })).toHaveCount(0);
            await page.goto(`${origin}/discussion/${note.id}`);
            await expect(page.getByRole("region", { name: "Discussion coverage", exact: true })).toHaveCount(0);
            await expect(page.locator("article").first()).toBeVisible();
            await page.getByRole("button", { name: "Boost", exact: true }).first().click();
            await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", `lightning:${invoice}`);
            expect(await page.evaluate(key => sessionStorage.getItem(key!), saved)).toBe(before);
            expect(requests).toHaveLength(1);
        }
        await page.getByRole("button", { name: "Copy invoice", exact: true }).click();
        await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
        expect(copiedInvoices).toEqual([invoice]);
        const qr = page.getByRole("img", { name: "Holoboard visibility invoice QR code" });
        await expect(qr).toBeVisible();
        const png = PNG.sync.read(await qr.screenshot());
        expect(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data.toLowerCase()).toBe(invoice);
        const api = await page.goto(`${origin}/api/promote/status?payment_hash=example`);
        expect(api?.status()).toBe(418);
        expect(await api?.json()).toEqual({ error: "API navigation reached the server" });
        expect(writeFrames).toEqual([]);
        expect(errors).toEqual([]);
    } finally {
        await page.goto("about:blank");
        await stopServer(apiServer);
        await stopServer(server);
    }
});
