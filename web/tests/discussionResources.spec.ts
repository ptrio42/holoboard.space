import { test, expect, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { finalizeEvent, generateSecretKey, type Event } from "nostr-tools/pure";
import { matchFilter } from "nostr-tools/filter";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });
test.skip(process.env.HOLOBOARD_RESOURCE_CHECKS !== "1", "Opt-in production-bundle resource checks");
const key = generateSecretKey();
const make = (content: string, tags: string[][] = [], kind = 1, created_at = 1700000000) => finalizeEvent({ kind, created_at, content, tags }, key);
const roots = Array.from({ length: 4 }, (_, i) => make(`Resource focus ${i}`));
const replies = roots.flatMap(root => Array.from({ length: 128 }, (_, i) => make(`Reply ${i}: ${"bounded reading content ".repeat(32)}`, [["e", root.id, "", "root"]], 1, 1700000100 + i)));
const profile = make(JSON.stringify({ name: "Resource fixture" }), [], 0);
const relayList = make("", [["r", "wss://nos.lol"]], 10002);
async function saveReport(info: TestInfo, name: string, report: unknown) {
    await mkdir(info.outputDir, { recursive: true });
    const path = info.outputPath(`${name}.json`);
    await writeFile(path, JSON.stringify(report, null, 2) + "\n");
    await info.attach(name, { path, contentType: "application/json" });
}
async function setup(context: BrowserContext, page: Page, stalled = false) {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const active = new Set<string>();
    const blocked = new Set<string>();
    let sequence = 0, closed = 0, peakSockets = 0, peakRequests = 0, writes = 0;
    const sockets = new Set<number>();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === origin) return route.continue();
        if (request.method() !== "GET") return route.abort();
        const entries = roots.map((event, i) => ({ id: event.id, event, rank: i + 1, weight: 200, sats_paid: 210, first_paid_at: 1700000000, last_paid_at: 1700000000 }));
        const data = url.pathname.includes("waiting-updates") ? { count: 0, note_ids: [], checked_at: Date.now() } :
            { entries, targets: [], total: entries.length, active_posts: entries.length, has_more: false, posts: entries.length, total_sats: 840 };
        if (!url.pathname.startsWith("/api/board")) return route.abort();
        return route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(data) });
    });
    await context.routeWebSocket("**/*", socket => {
        const connection = ++sequence;
        sockets.add(connection); peakSockets = Math.max(peakSockets, sockets.size);
        const ids = new Set<string>();
        socket.onClose(() => { sockets.delete(connection); for (const id of ids) active.delete(`${connection}:${id}`); closed++; });
        socket.onMessage(message => {
            const frame = JSON.parse(String(message));
            const id = `${connection}:${frame[1]}`;
            if (frame[0] === "CLOSE") { active.delete(id); ids.delete(frame[1]); return; }
            if (frame[0] !== "REQ") { writes++; throw new Error("Unexpected write in resource fixture"); }
            active.add(id); ids.add(frame[1]); peakRequests = Math.max(peakRequests, active.size);
            // Bodies are already in the real persistent read cache. Network reads
            // still run through the production transport and admission limits.
            for (const event of [...roots, profile, relayList]) if (frame.slice(2).some((filter: Parameters<typeof matchFilter>[0]) => matchFilter(filter, event))) socket.send(JSON.stringify(["EVENT", frame[1], event]));
            if (stalled && frame.slice(2).some((filter: Record<string, unknown>) => filter["#e"] || filter["#E"])) { blocked.add(id); return; }
            socket.send(JSON.stringify(["EOSE", frame[1]]));
        });
    });
    await page.goto("/");
    await expect(page.locator("article").first()).toBeVisible();
    // Seed only a new test context's expendable read cache, then let the app
    // hydrate and verify each signed fixture through its normal startup path.
    await page.evaluate(async (events: Event[]) => {
        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.open("holoboard-nostr-read-v1", 1);
            request.onupgradeneeded = () => request.result.createObjectStore("events", { keyPath: "event.id" });
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const db = request.result, transaction = db.transaction("events", "readwrite");
                for (const event of events) transaction.objectStore("events").put({ event, expires: Date.now() + 600000, size: JSON.stringify(event).length * 3 });
                transaction.oncomplete = () => { db.close(); resolve(); };
                transaction.onerror = () => reject(transaction.error);
            };
        });
    }, [...roots, ...replies, profile, relayList]);
    await page.reload();
    await expect(page.locator("article").first()).toBeVisible();
    return { active, blocked, errors, closed: () => closed, usage: () => ({ sockets: sockets.size, requests: active.size, peakSockets, peakRequests, writes }) };
}

async function enter(page: Page, index: number) {
    await page.locator("article").nth(index).getByRole("link", { name: "Discussion", exact: true }).click();
    await expect(page.getByRole("heading", { name: "128 found replies", exact: true })).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole("region", { name: "Replies", exact: true }).locator("article")).toHaveCount(48);
}
async function leave(page: Page) {
    await page.getByRole("link", { name: "Back to board" }).click();
    await expect(page.getByRole("region", { name: "Discussion coverage" })).toHaveCount(0);
}
function bounded(usage: { peakSockets: number; peakRequests: number; writes: number }) {
    // The relay fixture sees actual frames after the app's socket governor.
    // Nonzero assertions prevent a disconnected observer from silently passing.
    expect(usage.peakSockets).toBeGreaterThan(0);
    expect(usage.peakSockets).toBeLessThanOrEqual(12);
    expect(usage.peakRequests).toBeGreaterThan(0);
    expect(usage.peakRequests).toBeLessThanOrEqual(48);
    expect(usage.writes).toBe(0);
    return usage;
}

test("production retained heap stays within allowance across large discussion reopen cycles", async ({ context, page }, info) => {
    test.skip(info.project.name !== "desktop", "CDP heap measurements require Chromium desktop");
    const fixture = await setup(context, page);
    const cdp = await context.newCDPSession(page);
    const samples: number[] = [];
    for (let cycle = 0; cycle < 24; cycle++) {
        await enter(page, cycle % roots.length);
        await expect(page.getByRole("region", { name: "Discussion coverage" })).toHaveAttribute("data-read-state", /^(paused|settled)$/);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await leave(page);
        await expect.poll(() => fixture.active.size).toBe(0);
        await cdp.send("HeapProfiler.collectGarbage");
        const usage = await cdp.send("Runtime.getHeapUsage");
        samples.push(usage.usedSize);
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    // Two full rotations warm caches and browser internals. Compare equal
    // focus sets after warmup with an explicit absolute/relative noise margin.
    const early = median(samples.slice(8, 12)), late = median(samples.slice(-4));
    const allowance = Math.max(2 * 1024 * 1024, early * 0.2);
    const peak = bounded(fixture.usage());
    await expect.poll(() => fixture.usage().sockets, { timeout: 22000 }).toBeLessThanOrEqual(1);
    const idle = fixture.usage();
    const report = { cycles: samples.length, roots: roots.length, repliesPerRoot: 128, cachedEvents: 518, samples, earlyMedian: early, lateMedian: late, growth: late - early, allowance, peak, idle, closedSockets: fixture.closed(), errors: fixture.errors };
    await saveReport(info, "production-resource-report", report);
    console.log(JSON.stringify(report));
    expect(late - early).toBeLessThanOrEqual(allowance);
    expect(fixture.errors).toEqual([]);
    expect(idle.requests).toBe(0);
    await cdp.detach();
});

test("navigation cancels stalled reads across repeated large discussions", async ({ context, page }, info) => {
    const fixture = await setup(context, page, true);
    for (let cycle = 0; cycle < 8; cycle++) {
        const previous = fixture.blocked.size;
        await enter(page, cycle % roots.length);
        await expect.poll(() => fixture.blocked.size).toBeGreaterThan(previous);
        await leave(page);
        await expect.poll(() => fixture.active.size).toBe(0);
    }
    const peak = bounded(fixture.usage());
    await expect.poll(() => fixture.usage().sockets, { timeout: 22000 }).toBeLessThanOrEqual(1);
    expect(fixture.errors).toEqual([]);
    await saveReport(info, "cancelled-resource-report", { cycles: 8, peak, idle: fixture.usage(), closedSockets: fixture.closed(), blockedReads: fixture.blocked.size, errors: fixture.errors });
});
