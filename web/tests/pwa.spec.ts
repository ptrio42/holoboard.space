import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { PNG } from "pngjs";
import jsQR from "jsqr";

test.use({ serviceWorkers: "allow" });

const legacyDist = process.env.HOLOBOARD_LEGACY_DIST;
const currentDist = resolve(process.cwd(), "dist");
const types: Record<string, string> = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };

test("previous frontend works with current API and PWA updates preserve prepared invoices", async ({ context, page }) => {
    test.skip(!legacyDist, "Set HOLOBOARD_LEGACY_DIST to a built previous frontend; build the current frontend with the local mock relay.");
    test.setTimeout(90000);
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
        const directory = version === "legacy" ? legacyDist! : currentDist;
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
            if (request[0] !== "REQ") return;
            if (request.slice(2).some((filter: { kinds?: number[] }) => filter.kinds?.includes(1))) socket.send(JSON.stringify(["EVENT", request[1], note]));
            socket.send(JSON.stringify(["EOSE", request[1]]));
        });
    });
    try {
        await page.goto(origin);
        await page.waitForFunction(() => !!navigator.serviceWorker.controller);
        await page.getByRole("button", { name: "Boost", exact: true }).first().click();
        await page.getByRole("button", { name: "Get invoice, 210 sats", exact: true }).click();
        await expect(page.getByRole("link", { name: "Open in a wallet", exact: true })).toHaveAttribute("href", "lightning:lnbc-compatibility-1");
        expect(requests[0].amount_sats).toBe(210);
        expect(requests[0]).not.toHaveProperty("author_share");
        version = "current";
        await updateWorker();
        await expect(page.getByRole("link", { name: "Waiting room", exact: true })).toBeVisible({ timeout: 30000 });
        await page.getByRole("button", { name: "Boost", exact: true }).first().click();
        await page.getByRole("button", { name: "Boost 210 sats", exact: true }).click();
        await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", "lightning:lnbc-compatibility-2");
        await expect.poll(() => statusRequests.some((request) => request.hash === "2".repeat(64) && request.note === note.id && request.method === "GET" && request.accept === "application/json")).toBe(true);
        const saved = await page.evaluate(() => sessionStorage.getItem("holoboard-last-payment"));
        expect(saved).toBeTruthy();
        const before = await page.evaluate((key) => sessionStorage.getItem(key!), saved);
        const checksBeforeUpdate = statusRequests.filter((request) => request.hash === "2".repeat(64)).length;
        workerRevision++;
        await updateWorker();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await page.getByRole("button", { name: "Boost", exact: true }).first().click();
        await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", "lightning:lnbc-compatibility-2");
        expect(await page.evaluate((key) => sessionStorage.getItem(key!), saved)).toBe(before);
        expect(requests).toHaveLength(2);
        await expect.poll(() => statusRequests.filter((request) => request.hash === "2".repeat(64) && request.note === note.id).length).toBeGreaterThan(checksBeforeUpdate);
        await page.getByRole("button", { name: "Copy invoice", exact: true }).click();
        await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
        expect(copiedInvoices).toEqual(["lnbc-compatibility-2"]);
        const qr = page.getByRole("img", { name: "Holoboard visibility invoice QR code" });
        await expect(qr).toBeVisible();
        const png = PNG.sync.read(await qr.screenshot());
        expect(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data.toLowerCase()).toBe("lnbc-compatibility-2");
        const api = await page.goto(`${origin}/api/promote/status?payment_hash=example`);
        expect(api?.status()).toBe(418);
        expect(await api?.json()).toEqual({ error: "API navigation reached the server" });
        expect(errors).toEqual([]);
    } finally {
        await page.goto("about:blank");
        apiServer.closeAllConnections();
        await new Promise<void>((done, reject) => apiServer.close((error) => error ? reject(error) : done()));
        server.closeAllConnections();
        await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    }
});
