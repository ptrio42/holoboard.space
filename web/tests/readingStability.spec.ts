import { test, expect, type BrowserContext, type Page, type Route } from "@playwright/test";
import { finalizeEvent, generateSecretKey, type Event } from "nostr-tools/pure";
import { matchFilter } from "nostr-tools/filter";
import { noteEncode } from "nostr-tools/nip19";
import { PNG } from "pngjs";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });
const key = generateSecretKey();
const make = (content: string, tags: string[][] = [], kind = 1) => finalizeEvent({ kind, content, tags, created_at: 1700000000 }, key);
const photo = "https://media.example/late-portrait.png";
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="1000"><rect width="400" height="1000" fill="#164e63"/></svg>';

async function setup(context: BrowserContext, page: Page, type: "image" | "quote" | "link") {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const quoted = make("A delayed quoted note. ".repeat(20));
    const first = make(type === "image" ? `A photo arriving after you start reading.\n${photo}` : type === "quote" ? `An original note.\nnostr:${noteEncode(quoted.id)}` : "An original note with https://destination.example/page");
    const rest = Array.from({ length: 12 }, (_, i) => make(`Reading note ${i + 1}. A paragraph that stays on screen while earlier content arrives.`));
    const profile = make(JSON.stringify({ name: "Reading author" }), [], 0);
    const entries = [first, ...rest].map((event, index) => ({ id: event.id, event, rank: index + 1, weight: 200, sats_paid: 210 }));
    const pending: Route[] = [], releases: (() => void)[] = [], errors: string[] = [];
    let released = false;
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.href === photo) { pending.push(route); return; }
        if (url.origin !== "http://127.0.0.1:3334") return route.abort();
        if (url.pathname === "/api/link-preview") { pending.push(route); return; }
        return route.fulfill({ json: url.pathname.includes("waiting-updates") ? { count: 0, note_ids: [], checked_at: Date.now() } : { entries, targets: [], total: entries.length, active_posts: entries.length, has_more: false, total_sats: 2100 } });
    });
    await context.routeWebSocket("**/*", socket => {
        if (socket.url().startsWith(origin.replace(/^http/, "ws"))) return socket.connectToServer();
        socket.onMessage(message => {
            const frame = JSON.parse(String(message));
            if (frame[0] !== "REQ") return;
            const matches = (event: Event) => frame.slice(2).some((filter: Parameters<typeof matchFilter>[0]) => matchFilter(filter, event));
            if (type === "quote" && matches(quoted) && !released) {
                releases.push(() => { socket.send(JSON.stringify(["EVENT", frame[1], quoted])); socket.send(JSON.stringify(["EOSE", frame[1]])); });
                return;
            }
            for (const event of [profile, first, ...rest, ...(released ? [quoted] : [])]) if (matches(event)) socket.send(JSON.stringify(["EVENT", frame[1], event]));
            socket.send(JSON.stringify(["EOSE", frame[1]]));
        });
    });
    await page.goto("/");
    await expect(page.locator("[data-board-note]")).toHaveCount(entries.length);
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() => type === "quote" ? releases.length : pending.length).toBeGreaterThan(0);
    return {
        first, rest, errors,
        release: async (image = svg) => {
            released = true;
            for (const deliver of releases) deliver();
            for (const route of pending) await route.fulfill(type === "image" ? { contentType: "image/svg+xml", body: image } : { json: { url: "https://destination.example/page", title: "A delayed destination preview", description: "Metadata loaded after the reader moved further down." } });
        },
    };
}

for (const type of ["image", "quote", "link"] as const) test(`keeps the reading note in place when an earlier ${type} loads after scrolling`, async ({ context, page, browserName }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const fixture = await setup(context, page, type);
    const current = page.locator(`[data-board-note="${fixture.rest[3].id}"]`);
    await current.scrollIntoViewIfNeeded();
    if (browserName === "webkit") await page.evaluate(() => { window.dispatchEvent(new Event("touchstart")); window.scrollBy(0, 120); });
    else await page.mouse.wheel(0, 120);
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
    await page.waitForTimeout(150);
    const before = (await current.boundingBox())!.y;
    const painted: { top: number; scroll: number }[] = [];
    const cdp = browserName === "chromium" && process.env.HOLOBOARD_CAPTURE_FEED_FRAMES === "true" ? await context.newCDPSession(page) : null;
    if (cdp) {
        await current.evaluate(element => { element.style.outline = "4px solid #ff0000"; });
        cdp.on("Page.screencastFrame", event => {
            void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId });
            const image = PNG.sync.read(Buffer.from(event.data, "base64"));
            let top = -1;
            for (let y = 0; y < image.height && top < 0; y++) for (let x = 0; x < image.width; x++) {
                const at = (y * image.width + x) * 4;
                if (image.data[at] > 240 && image.data[at + 1] < 10 && image.data[at + 2] < 10) { top = y; break; }
            }
            painted.push({ top, scroll: event.metadata.scrollOffsetY });
        });
        await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
        await expect.poll(() => painted.some(frame => frame.top >= 0)).toBe(true);
        // CDP can first deliver a compositor frame from before the marker.
        painted.splice(0, painted.findIndex(frame => frame.top >= 0));
    }
    await page.evaluate(id => {
        const frames: number[] = [];
        const shifts: { value: number; sources: unknown[] }[] = [];
        if (PerformanceObserver.supportedEntryTypes.includes("layout-shift")) {
            const observer = new PerformanceObserver(list => {
                for (const entry of list.getEntries()) {
                    const shift = entry as PerformanceEntry & { value: number; sources: { node?: Element; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[] };
                    shifts.push({ value: shift.value, sources: shift.sources.map(source => ({ node: source.node?.tagName, class: source.node?.className, previous: source.previousRect, current: source.currentRect })) });
                }
            });
            observer.observe({ type: "layout-shift" });
        }
        Object.assign(window, { stableReadingFrames: frames, stableReadingShifts: shifts });
        let remaining = 60;
        const sample = () => {
            const row = document.querySelector(`[data-board-note="${id}"]`);
            if (row) frames.push(row.getBoundingClientRect().top);
            // ResizeObserver corrects layout after rAF and before paint. Read
            // in the following task so an unpainted layout is not a false jump.
            if (--remaining) requestAnimationFrame(() => setTimeout(sample, 0));
        };
        requestAnimationFrame(() => setTimeout(sample, 0));
    }, fixture.rest[3].id);
    await fixture.release();
    const first = page.locator(`[data-board-note="${fixture.first.id}"]`);
    if (type === "image") await expect(first.locator(".note-gallery__image img")).toHaveJSProperty("naturalWidth", 400);
    if (type === "quote") await expect(first.locator(".note-quote-content")).toBeAttached();
    if (type === "link") await expect(first.locator(".note-link-container")).toHaveAttribute("data-preview-state", "ready");
    await page.waitForTimeout(250);
    const frames = await page.evaluate(() => (window as unknown as { stableReadingFrames: number[] }).stableReadingFrames);
    const shifts = await page.evaluate(() => (window as unknown as { stableReadingShifts: { value: number }[] }).stableReadingShifts);
    if (cdp) { await cdp.send("Page.stopScreencast"); await cdp.detach(); }
    await info.attach("reading-offsets", { body: JSON.stringify({ before, frames, shifts, painted }), contentType: "application/json" });
    expect(frames.length).toBeGreaterThan(0);
    expect(Math.max(...frames.map(top => Math.abs(top - before)))).toBeLessThan(3);
    expect(Math.abs((await current.boundingBox())!.y - before)).toBeLessThan(3);
    // Chrome can attribute pre-compensation rectangles as layout shifts even
    // when the painted screencast keeps the reading block at the same pixel.
    if (cdp) {
        expect(painted.length).toBeGreaterThanOrEqual(2);
        expect(painted.every(frame => frame.top >= 0)).toBe(true);
        expect(Math.max(...painted.map(frame => frame.top)) - Math.min(...painted.map(frame => frame.top))).toBeLessThan(3);
    }
    expect(fixture.errors).toEqual([]);
});

test("keeps the last reading note steady when earlier media shrinks at the scroll limit", async ({ context, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const fixture = await setup(context, page, "image");
    const current = page.locator(`[data-board-note="${fixture.rest.at(-1)!.id}"]`);
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
    await page.waitForTimeout(150);
    const before = await current.evaluate(element => ({ top: element.getBoundingClientRect().top, height: document.documentElement.scrollHeight }));
    await fixture.release('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="100"><rect width="1000" height="100" fill="#164e63"/></svg>');
    await expect(page.locator(".note-gallery__image img")).toHaveJSProperty("naturalWidth", 1000);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(before.height - 50);
    await page.waitForTimeout(150);
    expect(Math.abs((await current.boundingBox())!.y - before.top)).toBeLessThan(3);
    expect(fixture.errors).toEqual([]);
});
