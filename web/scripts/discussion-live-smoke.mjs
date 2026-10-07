import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import process from "node:process";

if (process.env.HOLOBOARD_LIVE_READS !== "1") throw new Error("Set HOLOBOARD_LIVE_READS=1 to allow bounded public reads.");
const origin = process.env.HOLOBOARD_PREVIEW_ORIGIN ?? "http://127.0.0.1:4194";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) throw new Error("Use an isolated local preview origin.");
const output = process.env.HOLOBOARD_SMOKE_REPORT ?? "/private/tmp/holoboard-discussion-live-report.json";
async function waitUntil(probe, timeout = 22000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await probe()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Read cleanup did not complete before its deadline");
}
const browser = await chromium.launch({ channel: "chrome", headless: true });
const report = { started: new Date().toISOString(), origin, mode: "public reads only", cases: [], forbiddenFrames: [], pageErrors: [], requests: 0 };
try {
    const context = await browser.newContext({ serviceWorkers: "block", reducedMotion: "reduce" });
    await context.addInitScript(() => {
        const Native = window.WebSocket;
        const usage = window.__holoboardReadSmoke = { sockets: 0, connecting: 0, requests: 0, closing: 0, peakSockets: 0, peakConnecting: 0, peakRequests: 0 };
        window.WebSocket = class extends Native {
            constructor(url, protocols) {
                super(url, protocols);
                this.readOnlyRequests = new Set();
                if (new URL(this.url).hostname === "127.0.0.1") return;
                usage.sockets++; usage.connecting++;
                usage.peakSockets = Math.max(usage.peakSockets, usage.sockets);
                usage.peakConnecting = Math.max(usage.peakConnecting, usage.connecting);
                let connecting = true;
                this.addEventListener("open", () => { if (connecting) { connecting = false; usage.connecting--; } });
                this.addEventListener("close", () => {
                    usage.sockets--; if (this.readOnlyClosing) usage.closing--; if (connecting) usage.connecting--;
                    usage.requests -= this.readOnlyRequests.size; this.readOnlyRequests.clear();
                }, { once: true });
            }
            close(...args) {
                if (new URL(this.url).hostname !== "127.0.0.1" && this.readyState < 2 && !this.readOnlyClosing) {
                    this.readOnlyClosing = true; usage.closing++;
                }
                return super.close(...args);
            }
            send(data) {
                const local = new URL(this.url).hostname === "127.0.0.1";
                if (!local) {
                    let frame;
                    try { frame = JSON.parse(data); } catch { throw new Error("Non-JSON frame blocked by read-only smoke"); }
                    if (!Array.isArray(frame) || !["REQ", "CLOSE"].includes(frame[0])) throw new Error("Write frame blocked by read-only smoke");
                }
                const result = super.send(data);
                if (!local) {
                    const frame = JSON.parse(data);
                    if (frame[0] === "REQ" && !this.readOnlyRequests.has(frame[1])) { this.readOnlyRequests.add(frame[1]); usage.requests++; }
                    if (frame[0] === "CLOSE" && this.readOnlyRequests.delete(frame[1])) usage.requests--;
                    usage.peakRequests = Math.max(usage.peakRequests, usage.requests);
                }
                return result;
            }
        };
    });
    await context.route("**/*", route => {
        const request = route.request();
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) return route.abort();
        if (new URL(request.url()).origin !== origin && ["image", "media"].includes(request.resourceType())) return route.abort();
        return route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", error => report.pageErrors.push(error.message));
    page.on("websocket", socket => socket.on("framesent", ({ payload }) => {
        if (socket.url().startsWith(origin.replace(/^http/, "ws"))) return;
        try {
            const frame = JSON.parse(String(payload));
            if (frame[0] === "REQ") report.requests++;
            else if (frame[0] !== "CLOSE") report.forbiddenFrames.push(frame[0]);
        } catch { report.forbiddenFrames.push("non-json"); }
    }));
    const response = await context.request.get("https://relay.holoboard.space/api/board/campaigns?view=board&page=1");
    if (!response.ok()) throw new Error(`Public board returned ${response.status()}`);
    const board = await response.json();
    const entries = [board.entries.find(entry => entry.event.kind === 1 && !entry.event.tags.some(tag => tag[0] === "e" && tag[3] !== "mention")),
        board.entries.find(entry => entry.event.kind === 1111)].filter(Boolean);
    for (const entry of entries) {
        const event = entry.event;
        await page.goto(`${origin}/discussion/${event.id}?author=${event.pubkey}`, { waitUntil: "domcontentloaded" });
        await page.getByRole("region", { name: "Discussion coverage" }).waitFor({ timeout: 15000 });
        await page.waitForFunction(() => ["paused", "settled"].includes(document.querySelector('[aria-label="Discussion coverage"]')?.getAttribute("data-read-state")), undefined, { timeout: 35000 });
        const summary = await page.evaluate(async () => {
            const { discussionCoordinator } = await import("/src/lib/discussionReads.ts");
            const { socketUsage } = await import("/src/lib/socketBudget.ts");
            const session = [...discussionCoordinator.sessions.values()][0];
            const graph = discussionCoordinator.graph;
            const focus = graph.nodes.get(`event:${session.focusId}`);
            return { focusId: session.focusId, kind: focus?.event?.kind, parentState: focus?.parentState, rootState: focus?.rootState,
                issues: focus?.issues, focusLoaded: !!focus?.event, observed: session.observed.size,
                state: session.state, queries: session.requests, graphEvents: graph.events.size,
                sources: [...session.work.values()].map(work => ({ relay: work.relay, purpose: work.purpose, outcome: work.outcome ?? "not-queried", pages: work.pages, exhausted: work.exhausted, truncated: work.truncated })),
                limitations: [...session.limitations], socketUsage: { ...socketUsage },
                rendered: document.querySelectorAll('[data-discussion-key]').length,
                wirePeak: { ...window.__holoboardReadSmoke }, horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
        });
        summary.screenshot = `/private/tmp/holoboard-live-discussion-${event.kind}.png`;
        await page.screenshot({ path: summary.screenshot, fullPage: true });
        report.cases.push(summary);
        console.log(JSON.stringify({ focusId: summary.focusId, kind: summary.kind, observed: summary.observed, state: summary.state, outcomes: summary.sources.reduce((counts, source) => ({ ...counts, [source.outcome]: (counts[source.outcome] ?? 0) + 1 }), {}) }));
        await page.getByRole("link", { name: "Back to board" }).click();
        await waitUntil(() => page.evaluate(async () => (await import("/src/lib/discussionReads.ts")).discussionCoordinator.sessions.size === 0));
    }
    // Exercise a real addressable root through ordinary Nostr reads, without a fabricated event.
    const addressable = await page.evaluate(async () => {
        const { queryNostr } = await import("/src/lib/nostrTransport.ts");
        const { PUBLIC_RELAYS } = await import("/src/config.ts");
        const result = await queryNostr({ kinds: [30023], limit: 1 }, PUBLIC_RELAYS.slice(0, 2), { timeout: 5000 });
        return { event: result.events[0] && { id: result.events[0].id, pubkey: result.events[0].pubkey }, relays: result.relays };
    });
    report.addressableDiscovery = addressable;
    if (addressable.event) {
        await page.goto(`${origin}/discussion/${addressable.event.id}?author=${addressable.event.pubkey}`);
        await page.waitForFunction(() => ["paused", "settled"].includes(document.querySelector('[aria-label="Discussion coverage"]')?.getAttribute("data-read-state")), undefined, { timeout: 35000 });
        report.addressableScreen = await page.evaluate(async () => {
            const { discussionCoordinator: coordinator } = await import("/src/lib/discussionReads.ts");
            const session = [...coordinator.sessions.values()][0];
            return { focusLoaded: coordinator.graph.events.has(session.focusId), kind: coordinator.graph.events.get(session.focusId)?.kind,
                observed: session.observed.size, queries: session.requests, state: session.state,
                scopes: [...new Set([...session.work.values()].flatMap(work => Object.keys(work.filter).filter(key => key.startsWith("#"))))] };
        });
        await page.getByRole("link", { name: "Back to board" }).click();
    }
    if (process.env.HOLOBOARD_PROFILE_READS === "1") {
        const pubkey = entries.find(entry => entry.event.kind === 1111)?.event.pubkey ?? entries[0].event.pubkey;
        await page.goto(`${origin}/profile/${pubkey}`);
        await page.waitForFunction(() => ["partial", "settled"].includes(document.querySelector('[aria-label="Profile coverage"]')?.getAttribute("data-read-state")), undefined, { timeout: 20000 });
        report.profileScreen = await page.evaluate(async pubkey => {
            const { profileReader } = await import("/src/lib/profileReads.ts");
            const value = profileReader.sessions.get(pubkey)?.value;
            return { pubkey, loaded: !!value?.profile, state: value?.state, event: value?.event,
                relays: value?.relays, routing: value?.routing, cachedRouting: value?.cachedRouting,
                promotedNotes: document.querySelectorAll("[data-profile-note]").length,
                promotionCoverage: document.querySelector('[aria-label="Promotion coverage"]')?.textContent,
                overflow: document.documentElement.scrollWidth > innerWidth };
        }, pubkey);
        await page.screenshot({ path: "/private/tmp/holoboard-live-profile.png", fullPage: true });
        await page.getByRole("link", { name: "Back to board" }).click();
        await waitUntil(() => page.evaluate(async pubkey => !(await import("/src/lib/profileReads.ts")).profileReader.sessions.get(pubkey)?.views.size, pubkey));
        if (!report.profileScreen.loaded || report.profileScreen.overflow) throw new Error("Live profile smoke failed; inspect report.");
    }
    await waitUntil(() => page.evaluate(async () => (await import("/src/lib/discussionReads.ts")).discussionCoordinator.sessions.size === 0));
    report.afterClose = await page.evaluate(async () => ({ ...(await import("/src/lib/socketBudget.ts")).socketUsage }));
    report.idleSamples = [];
    await waitUntil(async () => {
        const sample = await page.evaluate(async () => ({ budget: { ...(await import("/src/lib/socketBudget.ts")).socketUsage }, wire: { ...window.__holoboardReadSmoke } }));
        if (!report.idleSamples.length || Date.now() - report.idleSamples.at(-1).time >= 1000) report.idleSamples.push({ time: Date.now(), ...sample });
        if (sample.budget.sockets <= 1 && sample.wire.sockets <= 1) { report.afterIdleWire = sample.wire; return true; }
        return false;
    }, 55000);
    report.afterIdle = await page.evaluate(async () => ({ ...(await import("/src/lib/socketBudget.ts")).socketUsage }));
    report.finished = new Date().toISOString();
    if (report.cases.length !== 2 || (report.addressableScreen && !report.addressableScreen.focusLoaded) || report.afterClose.requests !== 0 || report.afterIdle.sockets > 1 || report.afterIdle.requests !== 0 || report.afterIdleWire.peakSockets > 12 || report.afterIdleWire.peakConnecting > 4 || report.afterIdleWire.peakRequests > 48 || report.cases.some(item => !item.focusLoaded || item.horizontalOverflow || item.wirePeak.peakSockets < 1 || item.wirePeak.peakSockets > 12 || item.wirePeak.peakConnecting > 4 || item.wirePeak.peakRequests < 1 || item.wirePeak.peakRequests > 48) || report.forbiddenFrames.length || report.pageErrors.length) throw new Error("Live read smoke failed; inspect report.");
} catch (error) { report.failure = String(error); process.exitCode = 1; }
finally { await writeFile(output, JSON.stringify(report, null, 2) + "\n"); await browser.close(); }
console.log(`Report: ${output}`);
