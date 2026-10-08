import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { verifyEvent } from "nostr-tools/pure";
import { nprofileEncode } from "nostr-tools/nip19";

if (process.env.HOLOBOARD_LIVE_READS !== "1") throw new Error("Set HOLOBOARD_LIVE_READS=1 to allow bounded public reads.");
const apiOrigin = new URL(process.env.HOLOBOARD_API_ORIGIN ?? "https://relay.holoboard.space").href.replace(/\/$/, "");
const siteOrigin = "https://holoboard.space";
const previewOrigin = process.env.HOLOBOARD_PREVIEW_ORIGIN;
if (previewOrigin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(previewOrigin)) throw new Error("Use a loopback production preview.");
const report = { started: new Date().toISOString(), apiOrigin, mode: "GET and Nostr reads only", routes: [], browser: null };
const hex = /^[0-9a-f]{64}$/;
let browser;

async function readJSON(path, statuses = [200]) {
    const response = await fetch(`${apiOrigin}${path}`, {
        redirect: "error", signal: AbortSignal.timeout(20000),
        headers: { Accept: "application/json", Origin: siteOrigin },
    });
    const outcome = { path, status: response.status, contentType: response.headers.get("content-type"), cors: response.headers.get("access-control-allow-origin") };
    report.routes.push(outcome);
    assert.ok(statuses.includes(response.status), `Unexpected HTTP ${response.status}: ${path}`);
    assert.match(outcome.contentType ?? "", /^application\/json\b/, path);
    assert.ok(["*", siteOrigin].includes(outcome.cors), `Browser CORS: ${path}`);
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        assert.ok(bytes <= 2 * 1024 * 1024, `Response byte limit: ${path}`);
        chunks.push(chunk);
    }
    outcome.bytes = bytes;
    return JSON.parse(Buffer.concat(chunks).toString());
}

function campaign(data, view) {
    assert.ok(Array.isArray(data.entries) && Array.isArray(data.targets), view);
    assert.ok(data.entries.length <= 21, `Campaign page limit: ${view}`);
    assert.ok(Number.isSafeInteger(data.active_posts) && data.active_posts >= 0, view);
    assert.ok(Number.isSafeInteger(data.total) && data.total >= 0 && typeof data.has_more === "boolean", view);
    for (const entry of data.entries) {
        assert.match(entry.id, hex);
        assert.equal(entry.event.id, entry.id);
        assert.ok([1, 1111].includes(entry.event.kind), view);
        assert.ok(verifyEvent(entry.event), `Fresh campaign signature: ${view}`);
        assert.ok(Number.isSafeInteger(entry.rank) && entry.rank >= 1, view);
        assert.ok(Number.isFinite(entry.weight) && entry.weight > 0, view);
        assert.ok(Number.isFinite(entry.sats_paid) && entry.sats_paid >= 0, view);
    }
    report.routes.at(-1).entries = data.entries.length;
    report.routes.at(-1).activePosts = data.active_posts;
}

try {
    const ledger = await readJSON("/api/board");
    assert.ok(Array.isArray(ledger.entries));
    assert.ok(Number.isFinite(ledger.total_sats) && Number.isSafeInteger(ledger.posts));
    for (const entry of ledger.entries) {
        assert.match(entry.id, hex);
        assert.ok(Number.isSafeInteger(entry.rank) && entry.rank >= 1);
        assert.ok(Number.isFinite(entry.weight) && Number.isFinite(entry.sats_paid));
    }
    report.routes.at(-1).entries = ledger.entries.length;
    let board;
    for (const view of ["board", "top", "new", "hot"]) {
        const data = await readJSON(`/api/board/campaigns?view=${view}&page=1`);
        campaign(data, view);
        if (view === "board") board = data;
    }
    const updates = await readJSON("/api/board/waiting-updates");
    assert.ok(Number.isSafeInteger(updates.count) && updates.count >= 0 && Array.isArray(updates.note_ids));
    assert.ok(Number.isSafeInteger(updates.checked_at) && updates.checked_at > 0);
    const expired = await readJSON("/api/board/expired?limit=1");
    assert.ok(Array.isArray(expired.entries) && expired.entries.length <= 1);
    for (const entry of expired.entries) assert.ok(verifyEvent(entry.event), "Fresh expired-note signature");
    const preview = await readJSON("/api/link-preview?url=https%3A%2F%2Fexample.com", [200, 502]);
    if (report.routes.at(-1).status === 200) {
        assert.equal(new URL(preview.url).href, "https://example.com/");
        assert.equal(typeof preview.title, "string");
    } else assert.equal(preview.error, "page preview unavailable", "Existing preview handler must explain upstream failure");

    if (previewOrigin) {
        browser = await chromium.launch({ channel: "chrome", headless: true });
        const context = await browser.newContext({ serviceWorkers: "block", reducedMotion: "reduce" });
        const evidence = report.browser = { previewOrigin, pageErrors: [], blockedWrites: [], views: [], apiReads: 0, receivedRelayEvents: 0, relayEOSE: 0 };
        await context.route("**/*", route => {
            const request = route.request();
            if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
                evidence.blockedWrites.push(request.method());
                return route.abort();
            }
            const origin = new URL(request.url()).origin;
            if (origin !== previewOrigin && ["image", "media"].includes(request.resourceType())) return route.abort();
            if (origin === apiOrigin) evidence.apiReads++;
            return route.continue();
        });
        await context.routeWebSocket("**/*", socket => {
            const server = socket.connectToServer();
            server.onMessage(message => {
                try {
                    const frame = JSON.parse(String(message));
                    if (frame[0] === "EVENT") evidence.receivedRelayEvents++;
                    if (frame[0] === "EOSE") evidence.relayEOSE++;
                } catch { /* The application's ingress handles malformed relay data. */ }
                socket.send(message);
            });
            socket.onMessage(message => {
                let frame;
                try { frame = JSON.parse(String(message)); } catch { evidence.blockedWrites.push("non-JSON frame"); socket.close(); return; }
                if (!["REQ", "CLOSE"].includes(frame[0])) { evidence.blockedWrites.push(String(frame[0])); socket.close(); return; }
                server.send(message);
            });
        });
        const page = await context.newPage();
        page.on("pageerror", error => evidence.pageErrors.push(error.message));
        const { expect } = await import("@playwright/test");
        await page.goto(previewOrigin, { waitUntil: "domcontentloaded" });
        await expect(page.locator("[data-board-note]").first()).toBeVisible({ timeout: 25000 });
        const source = page.locator("[data-board-note]").first();
        const id = await source.getAttribute("data-board-note");
        const entry = board.entries.find(item => item.id === id);
        assert.ok(entry, "Visible note must belong to the observed board page");
        const link = source.getByRole("link", { name: "Discussion", exact: true });
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute("href", /^\/discussion\/nevent1/);
        await link.click();
        await expect(page.getByRole("article", { name: "Discussion focus", exact: true })).toBeVisible();
        await expect(page.getByRole("region", { name: "Discussion coverage", exact: true })).toHaveAttribute("data-read-state", /^(paused|settled)$/, { timeout: 35000 });
        await expect(page.getByRole("button", { name: "Reply", exact: true })).toHaveCount(0);
        evidence.views.push("board and seeded discussion");
        await page.goto(`${previewOrigin}/profile/${nprofileEncode({ pubkey: entry.event.pubkey, relays: ["wss://relay.holoboard.space"] })}`);
        await expect(page.getByRole("region", { name: "Author profile", exact: true })).toBeVisible();
        await expect(page.getByRole("region", { name: "Profile coverage", exact: true })).toHaveAttribute("data-read-state", /^(settled|partial)$/, { timeout: 20000 });
        await expect(page.locator(`[data-profile-note="${id}"]`)).toBeVisible({ timeout: 20000 });
        await expect(page.getByRole("button", { name: /Connect Nostr|Nostr signer/ })).toHaveCount(0);
        evidence.views.push("profile with production campaign membership");
        await page.goto(previewOrigin);
        assert.ok(evidence.apiReads > 0, "The compiled frontend must use the expected backend");
        assert.ok(evidence.receivedRelayEvents > 0, "Observe actual relay events, not only API-seeded note bodies");
        assert.deepEqual(evidence.pageErrors, []);
        assert.deepEqual(evidence.blockedWrites, []);
        await context.close();
    }
    report.passed = true;
} catch (error) {
    report.passed = false;
    report.failure = String(error);
    process.exitCode = 1;
} finally {
    await browser?.close();
    report.finished = new Date().toISOString();
    if (process.env.HOLOBOARD_SMOKE_REPORT) await writeFile(process.env.HOLOBOARD_SMOKE_REPORT, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
}
