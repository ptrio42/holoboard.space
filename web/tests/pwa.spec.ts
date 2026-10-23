import { test, expect, type Request as BrowserRequest } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { finalizeEvent, generateSecretKey, verifyEvent, type Event } from "nostr-tools/pure";
import { matchFilter } from "nostr-tools/filter";
import { neventEncode, nprofileEncode } from "nostr-tools/nip19";
import { PNG } from "pngjs";
import jsQR from "jsqr";

// Guest exports are test-memory only and must never enter a trace.
test.use({ serviceWorkers: "allow", trace: "off" });

import { activateWorker, expectPrivateStorage, invoiceSnapshots, privatePayments, resumeFoundationPayment, resumeGuidedPayment } from "./helpers/pwaRecovery";
import { walletInvoice } from "./helpers/walletFixture";

const legacyDist = process.env.HOLOBOARD_LEGACY_DIST;
const currentDist = resolve(process.env.HOLOBOARD_CURRENT_DIST ?? "dist");
const rollbackDist = process.env.HOLOBOARD_ROLLBACK_DIST;
const compatibilityRollbackDist = process.env.HOLOBOARD_COMPAT_ROLLBACK_DIST ?? rollbackDist;
const creationDist = process.env.HOLOBOARD_CREATION_DIST;
const creationOffDist = process.env.HOLOBOARD_CREATION_OFF_DIST;
const readerDist = process.env.HOLOBOARD_READER_DIST;
const enabledDist = process.env.HOLOBOARD_ENABLED_DIST;
const types: Record<string, string> = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };

async function stopServer(server: ReturnType<typeof createServer>) {
    if (!server.listening) return;
    await new Promise<void>((done, reject) => {
        server.close(error => error ? reject(error) : done());
        server.closeAllConnections();
    });
}

for (const mode of ["legacy", "readers", "enabled"] as const) test(mode !== "legacy"
    ? `${mode === "enabled" ? "enabled" : "read-only"} PWA update and code rollback preserve the original invoice`
    : "previous frontend works with current API and PWA updates preserve prepared invoices", async ({ context, page, browserName }, info) => {
    const readerRelease = mode !== "legacy", signerRelease = mode === "enabled";
    const previous = readerRelease ? compatibilityRollbackDist : legacyDist;
    const candidate = signerRelease ? enabledDist : readerRelease ? readerDist : currentDist;
    test.skip(!previous || !candidate, readerRelease
        ? `Set HOLOBOARD_COMPAT_ROLLBACK_DIST and HOLOBOARD_${signerRelease ? "ENABLED" : "READER"}_DIST to local-mock production builds.`
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
    const statusRequests: { hash: string | null; note: string | null; method: string | undefined; accept: string | undefined; document: string | string[] | undefined }[] = [];
    const errors: Error[] = [];
    const writeFrames: string[] = [];
    context.on("page", opened => opened.on("pageerror", error => errors.push(error)));
    page.on("pageerror", (error) => errors.push(error));
    const apiServer = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Holoboard-Test-Document");
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
            statusRequests.push({ hash: url.searchParams.get("payment_hash"), note: url.searchParams.get("note"), method: req.method, accept: req.headers.accept, document: req.headers["x-holoboard-test-document"] });
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
    const expectedUnavailableRequests = new WeakSet<BrowserRequest>();
    let unavailableLedgerFailures = 0;
    context.on("request", request => {
        if (!apiServer.listening && request.url() === `${apiOrigin}/api/board`) expectedUnavailableRequests.add(request);
    });
    context.on("requestfailed", request => {
        if (expectedUnavailableRequests.has(request)) unavailableLedgerFailures++;
    });
    await context.exposeFunction("testCopyInvoice", (invoice: string) => { copiedInvoices.push(invoice); });
    await context.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText: (invoice: string) => (window as unknown as { testCopyInvoice(value: string): Promise<void> }).testCopyInvoice(invoice) },
        });
    });
    // Use real cross-origin HTTP for CORS and service-worker checks. Redirect
    // only the configured test API to a private per-test mock server.
    await context.addInitScript(({ target, markDocument }) => {
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
            const original = input instanceof Request ? input.url : String(input);
            const url = new URL(original, window.location.href);
            if (url.origin !== "http://127.0.0.1:3334") return nativeFetch(input, init);
            const destination = `${target}${url.pathname}${url.search}${url.hash}`;
            const redirected = input instanceof Request ? new Request(destination, input) : destination;
            if (!markDocument) return nativeFetch(redirected, init);
            // The document's build meta survives claims by a newer worker. Old
            // polling must retain its old label even after the server switches.
            const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
            headers.set("X-Holoboard-Test-Document", document.querySelector('meta[name="holoboard-revision"]')?.getAttribute("content") ?? "unknown");
            return nativeFetch(redirected, { ...init, headers });
        };
    }, { target: apiOrigin, markDocument: !readerRelease });
    await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        return url.origin === origin || url.origin === apiOrigin ? route.continue() : route.abort();
    });
    const updateWorker = () => activateWorker(page);
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
        if (readerRelease) {
            // A creation-enabled foundation is not a substitute for this flag-off profile.
            await expect(page.getByRole("link", { name: "Discussion", exact: true })).toHaveCount(0);
            await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
        }
        await page.getByRole("button", { name: "Boost", exact: true }).first().click();
        await page.getByRole("button", { name: "Boost 210 sats", exact: true }).click();
        await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", "lightning:lnbc-compatibility-1");
        expect(requests[0].amount_sats).toBe(210);
        if (!readerRelease) expect(requests[0].author_share).toBe(0);
        const baselineKey = await page.evaluate(() => sessionStorage.getItem("holoboard-last-payment"));
        const baselinePayment = baselineKey ? await page.evaluate(key => sessionStorage.getItem(key), baselineKey) : null;
        const baselineRecords = readerRelease ? await invoiceSnapshots(page) : [];
        if (readerRelease) expect(baselineRecords).toHaveLength(1);
        const retained = readerRelease ? await context.newPage() : undefined;
        if (retained) {
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
        const baselineDocument = !readerRelease ? await page.locator('meta[name="holoboard-revision"]').getAttribute("content") : undefined;
        if (!readerRelease) expect(baselineDocument).toMatch(/^[a-f0-9]{40}$/);
        version = "current";
        await updateWorker();
        const candidateDocument = !readerRelease ? await page.locator('meta[name="holoboard-revision"]').getAttribute("content") : undefined;
        if (!readerRelease) {
            expect(candidateDocument).toMatch(/^[a-f0-9]{40}$/);
            expect(candidateDocument).not.toBe(baselineDocument);
            // Include every candidate request since startup, not just requests
            // made after opening the read-only Older invoices panel.
            expect(statusRequests.filter(request => request.document === candidateDocument && request.hash === "1".repeat(64))).toEqual([]);
        }
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
            await page.goto(`${origin}/discussion/${neventEncode({ id: note.id, author: note.pubkey, relays: ["ws://127.0.0.1:3334"] })}`);
            await expect(page.getByRole("article", { name: "Discussion focus", exact: true })).toContainText(note.content);
            if (signerRelease) {
                await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
                await page.getByRole("button", { name: "Reply", exact: true }).click();
                const editor = page.getByRole("dialog", { name: "Reply", exact: true });
                await editor.getByRole("textbox", { name: "Reply text" }).fill("Preserved unsigned reply draft 😀");
                await editor.getByRole("button", { name: "Close dialog", exact: true }).click();
            } else await expect(page.getByRole("button", { name: "Reply", exact: true })).toHaveCount(0);
            await page.goto(`${origin}/profile/${nprofileEncode({ pubkey: note.pubkey, relays: ["ws://127.0.0.1:3334"] })}`);
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
            expect(await invoiceSnapshots(page)).toEqual(baselineRecords);
        }
        await page.getByRole("button", { name: "Boost", exact: true }).first().click();
        if (!readerRelease) {
            await page.getByText("Older invoices", { exact: true }).click();
            await page.getByText("Holoboard: 210 sats", { exact: true }).click();
            const old = page.getByLabel("Older Holoboard invoice", { exact: true });
            await expect(old.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", "lightning:lnbc-compatibility-1");
            expect(await page.evaluate(key => sessionStorage.getItem(key!), baselineKey)).toBe(baselinePayment);
            await old.getByRole("button", { name: "Copy invoice", exact: true }).click();
            expect(copiedInvoices).toEqual(["lnbc-compatibility-1"]);
            const oldQr = PNG.sync.read(await old.getByRole("img", { name: "Older Holoboard invoice QR code", exact: true }).screenshot());
            expect(jsQR(new Uint8ClampedArray(oldQr.data), oldQr.width, oldQr.height)?.data.toLowerCase()).toBe("lnbc-compatibility-1");
            expect(await privatePayments(page)).toEqual([]);
            expect(statusRequests.filter(request => request.document === candidateDocument && request.hash === "1".repeat(64))).toEqual([]);
            await page.getByRole("button", { name: "Boost 210 sats", exact: true }).click();
        }
        const invoiceNumber = readerRelease ? 1 : 2;
        const invoice = `lnbc-compatibility-${invoiceNumber}`;
        const hash = String(invoiceNumber).repeat(64);
        await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", `lightning:${invoice}`);
        await expect.poll(() => statusRequests.some((request) => request.hash === hash && request.note === note.id && request.method === "GET" && request.accept === "application/json")).toBe(true);
        const before = await invoiceSnapshots(page);
        expect(before).toHaveLength(1);
        const checksBeforeUpdate = statusRequests.filter((request) => request.hash === hash).length;
        workerRevision++;
        await updateWorker();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await page.getByRole("button", { name: "Boost", exact: true }).first().click();
        await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", `lightning:${invoice}`);
        expect(await invoiceSnapshots(page)).toEqual(before);
        expect(requests).toHaveLength(invoiceNumber);
        await expect.poll(() => statusRequests.filter((request) => request.hash === hash && request.note === note.id).length).toBeGreaterThan(checksBeforeUpdate);
        if (readerRelease) {
            version = "legacy";
            await updateWorker();
            await expect(page.getByRole("link", { name: "Discussion", exact: true })).toHaveCount(0);
            await page.goto(`${origin}/discussion/${neventEncode({ id: note.id })}`);
            await expect(page.getByRole("region", { name: "Discussion coverage", exact: true })).toHaveCount(0);
            await expect(page.locator("article").first()).toBeVisible();
            await expect(page.getByRole("button", { name: "Reply", exact: true })).toHaveCount(0);
            if (signerRelease) {
                await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
                expect(await page.evaluate(id => JSON.parse(sessionStorage.getItem("holoboard-reply-drafts-v1") ?? "{}")[id], note.id)).toBe("Preserved unsigned reply draft 😀");
            }
            await page.getByRole("button", { name: "Boost", exact: true }).first().click();
            await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", `lightning:${invoice}`);
            expect(await invoiceSnapshots(page)).toEqual(before);
            expect(requests).toHaveLength(1);
        }
        await page.getByRole("button", { name: "Copy invoice", exact: true }).click();
        await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
        expect(copiedInvoices).toEqual(readerRelease ? [invoice] : ["lnbc-compatibility-1", invoice]);
        const qr = page.getByRole("img", { name: "Holoboard visibility invoice QR code" });
        await expect(qr).toBeVisible();
        const png = PNG.sync.read(await qr.screenshot());
        expect(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data.toLowerCase()).toBe(invoice);
        if (signerRelease) {
            version = "current";
            await updateWorker();
            await page.goto(`${origin}/discussion/${note.id}`);
            await page.getByRole("button", { name: "Reply", exact: true }).click();
            const editor = page.getByRole("dialog", { name: "Reply", exact: true });
            await expect(editor.getByRole("textbox", { name: "Reply text" })).toHaveValue("Preserved unsigned reply draft 😀");
            await editor.getByRole("button", { name: "Close dialog", exact: true }).click();
            expect(requests).toHaveLength(1);
        }
        const api = await page.goto(`${origin}/api/promote/status?payment_hash=example`);
        expect(api?.status()).toBe(418);
        expect(await api?.json()).toEqual({ error: "API navigation reached the server" });
        if (!readerRelease) {
            expect(statusRequests.every(request => request.document === baselineDocument || request.document === candidateDocument)).toBe(true);
            expect(statusRequests.some(request => request.document === baselineDocument && request.hash === "1".repeat(64))).toBe(true);
            expect(statusRequests.some(request => request.document === candidateDocument && request.hash === "2".repeat(64))).toBe(true);
            expect(statusRequests.filter(request => request.document === candidateDocument && request.hash === "1".repeat(64))).toEqual([]);
            await info.attach("legacy-document-requests", { contentType: "application/json", body: JSON.stringify({ baselineDocument, candidateDocument, statusRequests }, null, 2) });
        }
        expect(writeFrames).toEqual([]);
        // WebKit can report a caught native fetch failure as pageerror. Accept
        // only the exact ledger transport error paired with a failed request
        // that started while this test intentionally stopped the API server.
        const unexpected = errors.filter(error => {
            if (browserName === "webkit" && unavailableLedgerFailures > 0 &&
                error.stack?.startsWith(`Fetch API cannot load ${apiOrigin}/api/board due to access control checks.\n`)) {
                unavailableLedgerFailures--;
                return false;
            }
            return true;
        });
        expect(unexpected.map(error => error.message)).toEqual([]);
    } finally {
        await page.goto("about:blank");
        await stopServer(apiServer);
        await stopServer(server);
    }
});

test.describe("created-post recovery", () => {
    test("created-post PWA update and rollback preserve the signed invoice", async ({ context, page: initialPage }, info) => {
        test.skip(!rollbackDist || !creationDist || !creationOffDist, "Set HOLOBOARD_ROLLBACK_DIST, HOLOBOARD_CREATION_DIST and HOLOBOARD_CREATION_OFF_DIST to compatible local builds.");
        test.setTimeout(150000);
        let page = initialPage;
        let directory = rollbackDist!;
        let workerRevision = 1;
        let admission = true;
        let settled = false;
        const snapshots = new Map<string, Event>();
        const submittedSnapshots: Event[] = [];
        const promoted: Record<string, unknown>[] = [], statuses: string[] = [], errors: string[] = [], writes: string[] = [];
        const copied: string[] = [], signerCalls: string[] = [];
        let guestExport = "";
        const hash = "c".repeat(64);
        const invoice = walletInvoice({ hash, amountMsats: 210000 });
        const body = async (request: AsyncIterable<unknown>) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
            return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        };
        const api = createServer(async (req, res) => {
            const url = new URL(req.url ?? "/", "http://localhost");
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type");
            res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
            res.setHeader("Cache-Control", "no-store");
            if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
            const input = await body(req);
            let data: unknown;
            const published = settled ? [...snapshots.values()].map(event => ({ id: event.id, event, rank: 1, sats_paid: 210, weight: 210, author_share: 0 })) : [];
            if (url.pathname === "/api/board") data = { entries: published, posts: published.length, total_sats: settled ? 210 : 0, updated_at: 1700000000 };
            else if (url.pathname === "/api/board/campaigns") data = { entries: published, targets: published, total: published.length, active_posts: published.length, total_sats: settled ? 210 : 0, has_more: false };
            else if (url.pathname === "/api/board/waiting-updates") data = { count: 0, note_ids: [], checked_at: Date.now() };
            else if (url.pathname === "/api/promote/preview") {
                if (input.event) {
                    const event = JSON.parse(JSON.stringify(input.event)) as Event;
                    if (!verifyEvent(event)) { res.writeHead(400); res.end(); return; }
                    if (!admission && !snapshots.has(event.id)) { res.writeHead(403); res.end(); return; }
                    snapshots.set(event.id, JSON.parse(JSON.stringify(event)));
                    submittedSnapshots.push(JSON.parse(JSON.stringify(event)));
                }
                const event = snapshots.get(input.event?.id ?? input.note);
                if (!event) { res.writeHead(404); res.end(); return; }
                data = { event, active: settled, sats_paid: settled ? 210 : 0, weight: settled ? 210 : 0, rank: settled ? 1 : 0, author_share: 0, billboard_fee_sats: 100, images: [] };
            } else if (url.pathname === "/api/support") data = { available: false, author: input.event?.pubkey ?? [...snapshots.values()][0]?.pubkey, reason_code: "no_address", min_sats: 0, max_sats: 0, allows_nostr: false };
            else if (url.pathname === "/api/promote") {
                if (!admission) { res.writeHead(403); res.end(); return; }
                promoted.push(input);
                data = { invoice, payment_hash: hash, amount_sats: 210, promotion_sats: 210, billboard_fee_sats: 0, note_id: input.event.id, expires_at: Math.floor(Date.now() / 1000) + 3600 };
            } else if (url.pathname === "/api/promote/status") {
                statuses.push(url.searchParams.get("payment_hash") ?? "");
                if (url.searchParams.get("payment_hash") !== hash || url.searchParams.get("note") !== [...snapshots.keys()][0]) { res.writeHead(404); res.end(); return; }
                data = { pending: !settled, settled, publication: settled ? "pending" : undefined, receipt: settled ? { promotion_sats: 210 } : undefined };
            } else { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data));
        });
        const server = createServer(async (req, res) => {
            const path = new URL(req.url ?? "/", "http://localhost").pathname;
            res.setHeader("Cache-Control", "no-store");
            if (/^\/(api|relay|\.well-known)(\/|$)/.test(path)) { res.writeHead(418); res.end(); return; }
            const file = path === "/" || !extname(path) ? "/index.html" : path;
            const target = resolve(directory, `.${file}`);
            if (!target.startsWith(resolve(directory) + "/")) { res.writeHead(403); res.end(); return; }
            try {
                let content = await readFile(target);
                if (file === "/sw.js") content = Buffer.from(`${content.toString()}\n// Created-post test worker ${workerRevision}\n`);
                res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" }); res.end(content);
            } catch { res.writeHead(404); res.end(); }
        });
        await new Promise<void>(done => api.listen(0, "127.0.0.1", done));
        await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
        const apiAddress = api.address(), address = server.address();
        if (!address || typeof address === "string" || !apiAddress || typeof apiAddress === "string") throw new Error("Missing native listener");
        const origin = `http://127.0.0.1:${address.port}`, apiOrigin = `http://127.0.0.1:${apiAddress.port}`;
        page.on("pageerror", error => errors.push(error.message));
        context.on("page", opened => opened.on("pageerror", error => errors.push(error.message)));
        await context.exposeFunction("capturePwaCopy", (value: string) => { if (value.startsWith("nsec1")) guestExport = value; else copied.push(value); });
        await context.exposeFunction("recordPwaSigner", (method: string) => { signerCalls.push(method); throw new Error("Unexpected signer request"); });
        await context.addInitScript(target => {
            Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (value: string) => (window as unknown as { capturePwaCopy(value: string): Promise<void> }).capturePwaCopy(value) } });
            const nativeFetch = window.fetch.bind(window);
            window.fetch = (input, init) => {
                const url = new URL(input instanceof Request ? input.url : String(input), location.href);
                if (url.origin !== "http://127.0.0.1:3334") return nativeFetch(input, init);
                const destination = `${target}${url.pathname}${url.search}`;
                return nativeFetch(input instanceof Request ? new Request(destination, input) : destination, init);
            };
            // Any unexpected account or wallet operation is observable, without a real signer.
            const signer = (method: string) => (window as unknown as { recordPwaSigner(method: string): Promise<never> }).recordPwaSigner(method);
            Object.assign(window, { nostr: { getPublicKey: () => signer("getPublicKey"), signEvent: () => signer("signEvent") } });
        }, apiOrigin);
        await context.route("**/*", route => [origin, apiOrigin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
        await context.routeWebSocket("**/*", socket => {
            socket.onMessage(raw => {
                const frame = JSON.parse(String(raw));
                if (frame[0] === "CLOSE") return;
                if (frame[0] !== "REQ") { writes.push(frame[0]); return; }
                if (settled) for (const event of snapshots.values()) if (frame.slice(2).some((filter: Parameters<typeof matchFilter>[0]) => matchFilter(filter, event))) socket.send(JSON.stringify(["EVENT", frame[1], event]));
                socket.send(JSON.stringify(["EOSE", frame[1]]));
            });
        });
        let original: { event: Event; board: unknown; recoveryBackend: unknown };
        const checkSaved = async () => {
            const records = await privatePayments(page);
            expect(records).toHaveLength(1);
            const value = JSON.parse(records[0].value);
            expect({ event: value.event, board: value.board, recoveryBackend: value.recoveryBackend }).toEqual(original);
            expect(verifyEvent(value.event)).toBe(true);
            expect(records[0].backend).toBe(JSON.stringify(original.recoveryBackend));
            expect(snapshots.size).toBe(1); expect(promoted).toHaveLength(1); expect(writes).toEqual([]);
            for (const event of submittedSnapshots) expect(event).toEqual(original.event);
            await expectPrivateStorage(page, guestExport, settled ? undefined : original.event.id);
        };
        const checkInvoice = async (stage: string) => {
            await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", `lightning:${invoice}`);
            const qr = page.getByRole("img", { name: "Holoboard visibility invoice QR code" });
            await expect(qr).toBeVisible();
            const capture = await qr.screenshot();
            const png = PNG.sync.read(capture);
            expect(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data.toLowerCase()).toBe(invoice);
            await info.attach(`${stage}-rendered-qr`, { body: capture, contentType: "image/png" });
            await page.getByRole("button", { name: "Copy invoice", exact: true }).click();
            expect(copied.at(-1)).toBe(invoice);
            await checkSaved();
        };
        const move = async (next: string, allowed: boolean, stage: string, resume = resumeGuidedPayment) => {
            directory = next; admission = allowed; workerRevision++;
            const checks = statuses.length;
            await activateWorker(page);
            await resume(page);
            await expect.poll(() => statuses.length).toBeGreaterThan(checks);
            await checkInvoice(stage);
        };
        try {
            await page.goto(origin);
            await page.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated");
            // Foundation labels and category tabs are legitimate baseline behavior.
            await page.getByRole("button", { name: "Add to board", exact: true }).click();
            await expect(page.getByRole("tablist", { name: "Promotion editor", exact: true })).toBeVisible();
            await page.getByRole("textbox", { name: "Text or link" }).fill("Private guest post retained through a real PWA rollback");
            await page.getByRole("button", { name: "Review post", exact: true }).click();
            await page.getByRole("button", { name: "Save author key", exact: true }).click();
            await page.getByRole("button", { name: "Copy private author key", exact: true }).click();
            expect(guestExport.startsWith("nsec1")).toBe(true);
            await page.getByRole("button", { name: "Add to board 210 sats", exact: true }).click();
            await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toBeVisible();
            await expect.poll(async () => (await privatePayments(page)).length).toBe(1);
            const saved = JSON.parse((await privatePayments(page))[0].value);
            original = { event: JSON.parse(JSON.stringify(saved.event)), board: saved.board, recoveryBackend: saved.recoveryBackend };
            expect(original.event).toEqual(JSON.parse(JSON.stringify(promoted[0].event)));
            expect(original.event.tags).toContainEqual(["L", "space.holoboard.attribution"]);
            await checkInvoice("foundation");
            await move(creationDist!, true, "candidate-on");
            await move(rollbackDist!, true, "foundation-rollback", resumeFoundationPayment);
            await page.close();
            page = await context.newPage();
            const reopening = await page.goto(origin);
            expect(reopening?.fromServiceWorker()).toBe(true);
            expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
            await resumeFoundationPayment(page);
            await checkInvoice("foundation-fresh-page");
            await move(creationOffDist!, false, "candidate-off");
            await page.getByRole("button", { name: "Close dialog", exact: true }).click();
            await page.getByRole("button", { name: "Add to board", exact: true }).click();
            await expect(page.getByRole("textbox", { name: "Text or link" })).toHaveCount(0);
            await page.getByRole("textbox", { name: "Post link", exact: true }).fill("A new guest post must stay unavailable while creation is off");
            await expect(page.getByRole("button", { name: "Review & continue", exact: true })).toBeDisabled();
            await page.getByRole("button", { name: "Close dialog", exact: true }).click();
            await move(creationDist!, true, "reenabled");
            await move(creationOffDist!, false, "settlement-off");
            settled = true;
            await expect(page.getByLabel("Promotion result")).toContainText("Delivery to other apps is pending", { timeout: 20000 });
            await checkSaved();
            await page.getByRole("button", { name: "Done", exact: true }).click();
            await expect(page.getByRole("dialog")).toHaveCount(0);
            expect(statuses.every(value => value === hash)).toBe(true);
            expect(errors).toEqual([]); expect(writes).toEqual([]); expect(signerCalls).toEqual([]); expect(promoted).toHaveLength(1); expect(snapshots.size).toBe(1);
            await info.attach("created-post-cycle", { contentType: "application/json", body: JSON.stringify({ event: original.event, board: original.board, recoveryBackend: original.recoveryBackend, promoted: promoted.length, snapshots: snapshots.size, statusChecks: statuses.length, publicWriteFrames: writes, builds: { foundation: rollbackDist, candidateOn: creationDist, candidateOff: creationOffDist }, syntheticInvoice: true }, null, 2) });
        } finally {
            guestExport = "";
            if (!page.isClosed()) await page.goto("about:blank");
            await stopServer(api); await stopServer(server);
        }
    });
});
