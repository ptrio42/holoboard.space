import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { finalizeEvent, generateSecretKey, type Event } from "nostr-tools/pure";
import { matchFilter } from "nostr-tools/filter";
import { neventEncode } from "nostr-tools/nip19";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });
const enabled = process.env.VITE_ENABLE_DISCUSSIONS === "true";
const author = generateSecretKey();
const make = (content: string, tags: string[][] = [], created_at = 1700000000, kind = 1) => finalizeEvent({ kind, created_at, content, tags }, author);
const root = make("Protocol root context", [], 1700000100);
const focus = make("Original promoted middle reply", [["e", root.id, "", "root"], ["e", root.id, "", "reply"]], 1700000000);
const child = make("Unpaid intermediate reply", [["e", root.id, "", "root"], ["e", focus.id, "", "reply"]], 1700000300);
const paid = make("Promoted grandchild", [["e", root.id, "", "root"], ["e", child.id, "", "reply"]], 1700000200);
const promo = make("Holoboard promotional quote", [["q", focus.id]], 1700000400);
const wrong = make("Reply belongs to promotional quote", [["e", promo.id, "", "root"]]);
const mention = make("Mention is not a reply", [["e", focus.id, "", "mention"]]);
const profile = make(JSON.stringify({ name: "Discussion author" }), [], 1700000000, 0);
const relayList = make("", [["r", "ws://127.0.0.1:3334"]], 1700000000, 10002);
interface Options { focus?: Event; events?: Event[]; slowParent?: Event; blockReplies?: boolean; many?: number; board?: Event[]; preview?: boolean; billboard?: boolean }
async function setup(context: BrowserContext, page: Page, options: Options = {}) {
    const selected = options.focus ?? focus;
    const extra = Array.from({ length: options.many ?? 0 }, (_, i) => make(`Sibling ${String(i + 1).padStart(2, "0")}`, [["e", selected.id, "", "reply"]], 1700000500 + i));
    const events = [selected, root, child, paid, promo, wrong, mention, profile, relayList, ...(options.events ?? []), ...extra].filter(event => event.id !== options.slowParent?.id);
    const entry = (event: Event, rank: number) => ({ id: event.id, event, rank, weight: 200, sats_paid: 210, hot_sats: 200, ...(options.billboard && event.id === selected.id ? { billboard: { template: "poster", color: "cyan", size: "medium", speed: "normal", text: "Promoted note with a longer body." } } : {}), first_paid_at: 1700000000, last_paid_at: 1700000000 });
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const closes = new Set<string>(), blocked = new Set<string>(), publications: unknown[] = [];
    let deliver: (() => void) | undefined;
    let missingAvailable = false;
    let board = options.board;
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.origin !== "http://127.0.0.1:3334") return route.abort();
        if (options.preview && url.pathname === "/api/link-preview") return route.fulfill({ json: { url: "https://preview.example/page", title: "Cached page preview", description: "Known page metadata" }, headers: { "Access-Control-Allow-Origin": "*" } });
        const data = url.pathname.includes("waiting-updates") ? { count: 0, note_ids: [], checked_at: Date.now() } :
            { entries: board ? board.map((event, index) => entry(event, index + 1)) : [entry(selected, 1), entry(paid, 25)], targets: [], total: board?.length ?? 2, active_posts: board?.length ?? 2, has_more: false, posts: board?.length ?? 2, total_sats: 420 };
        return route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(data) });
    });
    await context.routeWebSocket("**/*", socket => {
        if (socket.url().startsWith(origin.replace(/^http/, "ws"))) return socket.connectToServer();
        socket.onMessage(message => {
            const msg = JSON.parse(String(message));
            if (msg[0] === "CLOSE") { closes.add(msg[1]); return; }
            if (msg[0] === "EVENT") { publications.push(msg); return; }
            if (msg[0] !== "REQ") return;
            if (options.slowParent && !missingAvailable && msg.slice(2).some((filter: { ids?: string[] }) => filter.ids?.includes(options.slowParent!.id))) {
                deliver = () => { missingAvailable = true; events.push(options.slowParent!); socket.send(JSON.stringify(["EVENT", msg[1], options.slowParent])); socket.send(JSON.stringify(["EOSE", msg[1]])); };
                return;
            }
            for (const event of events) if (msg.slice(2).some((filter: Parameters<typeof matchFilter>[0]) => matchFilter(filter, event))) socket.send(JSON.stringify(["EVENT", msg[1], event]));
            if (options.blockReplies && msg.slice(2).some((filter: Record<string, string[]>) => filter["#e"]?.includes(selected.id))) { blocked.add(msg[1]); return; }
            socket.send(JSON.stringify(["EOSE", msg[1]]));
        });
    });
    return { selected, publications, closes, blocked, deliver: () => deliver?.(), hasDelivery: () => !!deliver, replaceBoard: (events: Event[]) => { board = events; } };
}
async function drain(page: Page) {
    for (let i = 0; i < 10; i++) {
        const load = page.getByRole("button", { name: "Load more", exact: true });
        await expect(page.getByRole("region", { name: "Discussion coverage" })).toBeVisible();
        await expect(page.getByRole("region", { name: "Discussion coverage" })).toHaveAttribute("data-read-state", /^(paused|settled)$/, { timeout: 35000 });
        if (!(await load.count())) return;
        await load.click();
    }
}
const row = (page: Page, event: Event) => page.locator(`[data-discussion-key="event:${event.id}"]`);

test("discussion entry points stay disabled in the default release", async ({ context, page }) => {
    test.skip(enabled);
    await setup(context, page);
    await page.goto("/");
    await expect(page.locator("article").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Discussion", exact: true })).toHaveCount(0);
    await page.goto(`/discussion/${focus.id}`);
    await expect(page.getByRole("region", { name: "Discussion coverage" })).toHaveCount(0);
    await page.goto(`/discussion/${neventEncode({ id: focus.id })}`);
    await expect(page.getByRole("region", { name: "Discussion coverage" })).toHaveCount(0);
});

test.describe("read-only discussion", () => {
    test.skip(!enabled);
    test("joins discussion and boost in one footer and keeps comment context readable", async ({ context, page }, testInfo) => {
        const selected = make("Small projects need a place to be discovered.\n\nWe are building an open source map of places where you can pay with bitcoin. Add your favourite spot, or tell us what would make the map useful to you.");
        const novaKey = generateSecretKey(), riverKey = generateSecretKey();
        const reply = finalizeEvent({ kind: 1, created_at: 1700000100, tags: [["e", selected.id, "", "reply"]], content: "A filter for small local businesses would help. I would love to find a coffee shop on the way to work." }, novaKey);
        const nested = finalizeEvent({ kind: 1, created_at: 1700000200, tags: [["e", selected.id, "", "root"], ["e", reply.id, "", "reply"]], content: "Yes! And a simple way to confirm that a place still accepts bitcoin. Happy to test the first version." }, riverKey);
        const sibling = make("Thanks, both of those are on our list. The first version will work without an account.", [["e", selected.id, "", "reply"]], 1700000300);
        const profiles = [finalizeEvent({ kind: 0, created_at: 1700000000, tags: [], content: JSON.stringify({ name: "nova" }) }, novaKey), finalizeEvent({ kind: 0, created_at: 1700000000, tags: [], content: JSON.stringify({ name: "river" }) }, riverKey)];
        const fixture = await setup(context, page, { focus: selected, events: [reply, nested, sibling, ...profiles], board: [selected, nested] });
        await page.goto("/");
        const source = page.locator(`[data-board-note="${selected.id}"]`);
        const footer = source.locator("footer");
        await expect(footer.getByRole("link", { name: "Discussion", exact: true })).toBeVisible();
        await expect(footer.getByRole("button", { name: "Boost", exact: true })).toBeVisible();
        await expect(source.locator(".note-footer")).toHaveCount(1);
        await expect(page.locator(".board-rank__label")).toHaveText(["TOP"]);
        await page.evaluate(() => document.fonts.ready);
        await source.screenshot({ path: testInfo.outputPath("note-footer.png") });
        await footer.getByRole("link", { name: "Discussion", exact: true }).click();
        const focusCard = page.getByRole("article", { name: "Discussion focus" });
        await expect(focusCard.getByRole("link", { name: "Discussion", exact: true })).toHaveCount(0);
        await expect(focusCard.getByRole("button", { name: "Boost", exact: true })).toBeVisible();
        await drain(page);
        await expect(row(page, reply).getByRole("link", { name: "nova", exact: true })).toBeVisible();
        await expect(row(page, nested).getByRole("link", { name: /Go to parent note by nova/ })).toContainText(reply.content);
        await expect(row(page, nested).locator(".discussion-promotion")).toHaveText("Promoted");
        await expect(row(page, nested).getByRole("link", { name: "Open thread", exact: true })).toBeVisible();
        await page.locator("#discussion").screenshot({ path: testInfo.outputPath("discussion-comments.png") });
        await page.setViewportSize({ width: 320, height: 800 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const controls = await row(page, nested).locator(".discussion-actions a, .discussion-parent, header a").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect()));
        expect(controls.every(bounds => bounds.height >= 44 && bounds.right <= 320)).toBe(true);
        expect(fixture.publications).toEqual([]);
    });
    test("keeps the original middle focus, unpaid parents and promotion badges separate", async ({ context, page }) => {
        const fixture = await setup(context, page);
        await page.goto("/waiting?view=hot");
        const entry = page.locator("article").first();
        await expect(entry).toContainText(focus.content);
        const link = entry.getByRole("link", { name: "Discussion", exact: true });
        expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await page.evaluate(() => window.scrollTo(0, 80));
        const boardScroll = await page.evaluate(() => window.scrollY);
        await link.click();
        await expect(page.getByRole("article", { name: "Discussion focus" })).toContainText(focus.content);
        await drain(page);
        await expect(page.getByRole("region", { name: "Ancestor context" })).toContainText(root.content);
        await expect(row(page, child)).toContainText(child.content);
        await expect(row(page, child).locator(".discussion-promotion")).toHaveCount(0);
        await expect(row(page, paid)).toContainText(paid.content);
        await expect(row(page, paid).getByRole("link", { name: /Go to parent note by/ })).toContainText(child.content);
        await row(page, paid).getByRole("link", { name: /Go to parent note by/ }).click();
        await expect(row(page, child)).toBeFocused();
        await expect(row(page, paid).getByRole("link", { name: "Open thread", exact: true })).toBeVisible();
        await expect(page.getByText(/Reply level|Focus here/)).toHaveCount(0);
        await expect(row(page, paid).locator(".discussion-promotion")).toHaveText("Promoted");
        await expect(row(page, paid).locator(".discussion-promotion")).toBeVisible();
        await expect(page.getByText(wrong.content, { exact: true })).toHaveCount(0);
        await expect(page.getByText(mention.content, { exact: true })).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: `/private/tmp/holoboard-discussion-screen-${test.info().project.name}.png`, fullPage: true });
        await page.getByRole("link", { name: "Back to board" }).click();
        await expect(page).toHaveURL(/\/waiting\?view=hot$/);
        await expect(page.getByRole("button", { name: "Hot", exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(boardScroll);
        await page.goBack();
        await expect(row(page, paid)).toBeVisible();
        expect(fixture.publications).toEqual([]);
    });
    for (const billboard of [false, true]) for (const expanded of [false, true]) test(`preserves the board card geometry and exact return position (${billboard ? "billboard" : "ordinary"}, ${expanded ? "expanded" : "collapsed"})`, async ({ context, page }) => {
        const selected = make("Promoted note with a longer body.\n".repeat(26), [["e", root.id, "", "root"], ["e", root.id, "", "reply"]]);
        const filler = Array.from({ length: 10 }, (_, i) => make(`Board filler ${i}`, [], 1700000600 + i));
        const board = [...filler.slice(0, 5), selected, ...filler.slice(5)];
        const fixture = await setup(context, page, { focus: selected, board, slowParent: root, billboard });
        await page.goto("/waiting?view=hot");
        const source = page.locator(`[data-board-note="${selected.id}"]`);
        await expect(source).toContainText("Promoted note with a longer body.");
        await page.evaluate(() => document.fonts.ready);
        if (expanded) {
            if (billboard) {
                await source.getByRole("button", { name: "Note options", exact: true }).click();
                await page.getByRole("menuitem", { name: "Read original", exact: true }).click();
            } else await source.getByRole("button", { name: /Show more/ }).click();
        }
        const link = source.getByRole("link", { name: "Discussion", exact: true });
        await link.scrollIntoViewIfNeeded();
        const original = (await source.locator("article").boundingBox())!;
        const boardScroll = await page.evaluate(() => scrollY);
        // Sample animation-frame geometry as well as the final settled layout.
        await page.evaluate(id => {
            const samples: { x: number; y: number; width: number; height: number; scroll: number; gap: string; tail: string }[] = [];
            Object.assign(window, { readingFrames: samples });
            let remaining = 180;
            const sample = () => {
                const card = document.querySelector(`[data-reading-focus="${id}"] article`);
                if (card) {
                    const { x, y, width, height } = card.getBoundingClientRect();
                    const row = card.closest<HTMLElement>("[data-reading-focus]")!;
                    samples.push({ x, y, width, height, scroll: scrollY, gap: row.style.getPropertyValue("--reading-gap"),
                        tail: row.closest<HTMLElement>("[data-reading-surface]")?.style.getPropertyValue("--reading-tail") ?? "" });
                }
                if (--remaining) requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        }, selected.id);
        await link.click();
        const focusCard = page.getByRole("article", { name: "Discussion focus" });
        await expect(focusCard).toContainText("Promoted note with a longer body.");
        const sameGeometry = async () => {
            const current = (await focusCard.boundingBox())!;
            for (const axis of ["x", "y", "width", "height"] as const) expect(Math.abs(current[axis] - original[axis]), axis).toBeLessThan(2);
        };
        await sameGeometry();
        await expect.poll(fixture.hasDelivery).toBe(true);
        fixture.deliver();
        await expect(page.getByRole("region", { name: "Ancestor context" })).toContainText(root.content);
        await sameGeometry();
        const frames = await page.evaluate(() => (window as unknown as { readingFrames: typeof original[] }).readingFrames);
        await test.info().attach("reading-position", { contentType: "application/json", body: JSON.stringify({ original, frames }) });
        expect(frames.length).toBeGreaterThan(0);
        for (const frame of frames) for (const axis of ["x", "y", "width", "height"] as const) expect(Math.abs(frame[axis] - original[axis]), `frame ${axis}`).toBeLessThan(2);
        await page.goBack();
        await expect(page).toHaveURL(/\/waiting\?view=hot$/);
        expect(Math.abs((await source.locator("article").boundingBox())!.y - original.y)).toBeLessThan(2);
        expect(await page.evaluate(() => scrollY)).toBe(boardScroll);
        await expect(source.locator("[data-note-expanded]")).toHaveAttribute("data-note-expanded", String(expanded));
        await page.goForward();
        await expect(focusCard).toBeVisible();
        await sameGeometry();
        // A polling refresh can change the retained board while it is hidden.
        fixture.replaceBoard([make("New entry inserted above the promoted note"), ...board]);
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await expect(page.locator(`[data-board-note="${selected.id}"] .board-rank`)).toHaveAttribute("aria-label", "Rank 7");
        await page.getByRole("link", { name: "Back to board" }).click();
        await expect(page).toHaveURL(/\/waiting\?view=hot$/);
        await expect.poll(async () => Math.abs((await source.locator("article").boundingBox())!.y - original.y)).toBeLessThan(2);
        expect(await page.evaluate(() => scrollY)).toBeGreaterThan(boardScroll);
        expect(fixture.publications).toEqual([]);
    });
    test("keeps a short card in place at the end of the board", async ({ context, page }) => {
        const selected = make("Short promoted note");
        const fixture = await setup(context, page, { focus: selected, board: [make("First board note"), make("Second board note"), selected] });
        await page.addInitScript(() => {
            const replace = history.replaceState.bind(history);
            let replacements = 0;
            history.replaceState = (...args) => { replacements++; return replace(...args); };
            Object.defineProperty(window, "readingHistoryReplacements", { get: () => replacements });
        });
        await page.goto("/");
        const source = page.locator(`[data-board-note="${selected.id}"] article`);
        await expect(source).toContainText(selected.content);
        await page.evaluate(() => document.fonts.ready);
        const link = source.getByRole("link", { name: "Discussion", exact: true });
        await link.scrollIntoViewIfNeeded();
        const before = (await source.boundingBox())!;
        const scroll = await page.evaluate(() => scrollY);
        await link.click();
        const card = page.getByRole("article", { name: "Discussion focus" });
        await expect(card).toContainText(selected.content);
        await expect(page.getByRole("region", { name: "Discussion coverage" })).toHaveAttribute("data-read-state", /^(paused|settled)$/);
        expect(await page.evaluate(() => (window as unknown as { readingHistoryReplacements: number }).readingHistoryReplacements)).toBe(2);
        const after = (await card.boundingBox())!;
        for (const axis of ["x", "y", "width", "height"] as const) expect(Math.abs(after[axis] - before[axis]), axis).toBeLessThan(2);
        await page.getByRole("link", { name: "Back to board" }).click();
        await expect(page).toHaveURL(/\/$/);
        await expect.poll(async () => Math.abs((await source.boundingBox())!.y - before.y)).toBeLessThan(2);
        expect(await page.evaluate(() => scrollY)).toBe(scroll);
        expect(fixture.publications).toEqual([]);
    });
    test("keeps known quote and link previews in the first discussion frame", async ({ context, page }) => {
        const quoted = make("Cached quotation");
        const selected = make("Long source body.\n".repeat(20) + "https://preview.example/page", [["q", quoted.id]]);
        await setup(context, page, { focus: selected, events: [quoted], preview: true });
        await page.goto("/");
        const source = page.locator(`[data-board-note="${selected.id}"]`);
        await source.getByRole("button", { name: /Show more/ }).click();
        await expect(source.getByText(quoted.content, { exact: true })).toBeVisible();
        await expect(source.getByText("Cached page preview", { exact: true })).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        const link = source.getByRole("link", { name: "Discussion", exact: true });
        await link.scrollIntoViewIfNeeded();
        const before = (await source.locator("article").boundingBox())!;
        await page.evaluate(() => {
            const frames: { quote: boolean; preview: boolean; loading: boolean }[] = [];
            Object.assign(window, { previewFrames: frames });
            let remaining = 120;
            const sample = () => {
                const card = document.querySelector("[data-reading-focus] article");
                if (card) frames.push({ quote: card.textContent!.includes("Cached quotation"), preview: card.textContent!.includes("Cached page preview"), loading: card.textContent!.includes("Loading preview") });
                if (--remaining) requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        });
        await link.click();
        const card = page.getByRole("article", { name: "Discussion focus" });
        await expect(card.getByText(quoted.content, { exact: true })).toBeVisible();
        const frames = await page.evaluate(() => (window as unknown as { previewFrames: { quote: boolean; preview: boolean; loading: boolean }[] }).previewFrames);
        expect(frames.length).toBeGreaterThan(0);
        expect(frames.every(frame => frame.quote && frame.preview && !frame.loading)).toBe(true);
        const after = (await card.boundingBox())!;
        for (const axis of ["x", "y", "width", "height"] as const) expect(Math.abs(after[axis] - before[axis]), axis).toBeLessThan(2);
    });
    for (const expanded of [false, true]) test(`keeps fitted link placement in the first discussion frame (${expanded ? "expanded" : "collapsed"})`, async ({ context, page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.route("https://images.example/square.png", route => route.fulfill({
            contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="#164e63"/></svg>',
        }));
        const quoted = make("Known quotation beside the destination card.");
        const selected = make("Long source body.\n".repeat(20) + "https://images.example/square.png\nhttps://preview.example/page", [["q", quoted.id]]);
        await setup(context, page, { focus: selected, events: [quoted], preview: true });
        await page.goto("/");
        const source = page.locator(`[data-board-note="${selected.id}"]`);
        await expect(source.getByText(quoted.content, { exact: true })).toBeVisible();
        await expect(source.getByText("Cached page preview", { exact: true })).toBeVisible();
        await expect.poll(() => source.locator(".note-gallery img").evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(800);
        if (expanded) await source.getByRole("button", { name: "Show more note text", exact: true }).click();
        const placement = expanded ? "media" : "text";
        await expect(source.locator(".note-composition")).toHaveAttribute("data-link-placement", placement);
        await page.evaluate(() => document.fonts.ready);
        const link = source.getByRole("link", { name: "Discussion", exact: true });
        await link.scrollIntoViewIfNeeded();
        const original = (await source.locator("article").boundingBox())!;
        await page.evaluate(() => {
            const frames: { x: number; y: number; width: number; height: number; placement?: string }[] = [];
            Object.assign(window, { fittedLinkFrames: frames });
            let remaining = 90;
            const sample = () => {
                const card = document.querySelector("[data-reading-focus] article");
                if (card) {
                    const { x, y, width, height } = card.getBoundingClientRect();
                    frames.push({ x, y, width, height, placement: card.querySelector<HTMLElement>(".note-composition")?.dataset.linkPlacement });
                }
                if (--remaining) requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        });
        await link.click();
        const focus = page.getByRole("article", { name: "Discussion focus" });
        await expect(focus.locator(".note-composition")).toHaveAttribute("data-link-placement", placement);
        await page.waitForTimeout(200);
        const frames = await page.evaluate(() => (window as unknown as { fittedLinkFrames: (typeof original & { placement?: string })[] }).fittedLinkFrames);
        expect(frames.length).toBeGreaterThan(0);
        for (const frame of frames) {
            expect(frame.placement).toBe(placement);
            for (const axis of ["x", "y", "width", "height"] as const) expect(Math.abs(frame[axis] - original[axis]), `first-frame ${axis}`).toBeLessThan(2);
        }
        await page.getByRole("link", { name: "Back to board", exact: true }).click();
        await expect(source.locator(".note-composition")).toHaveAttribute("data-link-placement", placement);
        expect(Math.abs((await source.locator("article").boundingBox())!.y - original.y)).toBeLessThan(2);
    });
    for (const billboard of [false, true]) test(`preserves an independently expanded quote when entering and returning from discussion (${billboard ? "billboard" : "ordinary"})`, async ({ context, page }) => {
        await page.route("https://images.example/*.png", route => route.request().url().endsWith("4.png") ? route.abort() : route.fulfill({
            contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1920"><rect width="1440" height="1920" fill="#22d3ee"/></svg>',
        }));
        const quoted = make("Independent quote context. ".repeat(30) + "\n" + [1, 2, 3, 4].map(index => `https://images.example/${index}.png`).join("\n"));
        const selected = make("The main opening stays collapsed. ".repeat(30), [["q", quoted.id]]);
        await setup(context, page, { focus: selected, events: [quoted], board: [selected], billboard });
        await page.goto("/");
        const source = page.locator(`[data-board-note="${selected.id}"]`);
        const main = source.locator('[data-note-text="main"]');
        const quote = source.locator(`[data-note-text="quote:${quoted.id}"]`);
        await expect(source.locator(".note-gallery")).toHaveClass(/gallery-portraits/);
        await expect(source.locator(".note-gallery button")).toHaveCount(3);
        await quote.getByRole("button", { name: "Show more quoted note text", exact: true }).click();
        if (billboard) await expect(source.locator(".board-original")).toHaveCount(0);
        else await expect(main).toHaveAttribute("data-note-expanded", "false");
        const link = source.getByRole("link", { name: "Discussion", exact: true });
        await link.scrollIntoViewIfNeeded();
        const original = (await source.locator("article").boundingBox())!;
        await page.evaluate(() => {
            const frames: { x: number; y: number; width: number; height: number }[] = [];
            Object.assign(window, { galleryReadingFrames: frames });
            let remaining = 90;
            const sample = () => {
                const card = document.querySelector("[data-reading-focus] article");
                if (card) { const { x, y, width, height } = card.getBoundingClientRect(); frames.push({ x, y, width, height }); }
                if (--remaining) requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        });
        await link.click();
        const focus = page.getByRole("article", { name: "Discussion focus" });
        await expect(focus.locator(`[data-note-text="quote:${quoted.id}"]`)).toHaveAttribute("data-note-expanded", "true");
        if (billboard) await expect(focus.locator(".board-original")).toHaveCount(0);
        else await expect(focus.locator('[data-note-text="main"]')).toHaveAttribute("data-note-expanded", "false");
        const current = (await focus.boundingBox())!;
        for (const axis of ["x", "y", "width", "height"] as const) expect(Math.abs(current[axis] - original[axis]), axis).toBeLessThan(2);
        await page.waitForTimeout(200);
        const frames = await page.evaluate(() => (window as unknown as { galleryReadingFrames: typeof original[] }).galleryReadingFrames);
        expect(frames.length).toBeGreaterThan(0);
        for (const frame of frames) for (const axis of ["x", "y", "width", "height"] as const) expect(Math.abs(frame[axis] - original[axis]), `first-frame ${axis}`).toBeLessThan(2);
        await page.getByRole("link", { name: "Back to board", exact: true }).click();
        await expect(quote).toHaveAttribute("data-note-expanded", "true");
        expect(Math.abs((await source.locator("article").boundingBox())!.y - original.y)).toBeLessThan(2);
    });
    test("keeps a reading anchor stable when a missing ancestor arrives", async ({ context, page }) => {
        const focus = make("Reading a long promoted reply.\n".repeat(45), [["e", root.id, "", "root"], ["e", root.id, "", "reply"]]);
        const fixture = await setup(context, page, { focus, slowParent: root });
        await page.goto(`/discussion/${focus.id}?author=${focus.pubkey}`);
        await expect(row(page, focus)).toContainText("Reading a long promoted reply.");
        await expect.poll(fixture.hasDelivery).toBe(true);
        await page.evaluate(() => document.fonts.ready);
        await row(page, focus).getByRole("button", { name: /Show more/ }).click();
        await row(page, focus).scrollIntoViewIfNeeded();
        await page.evaluate(id => { const node = document.querySelector(`[data-discussion-key="event:${id}"]`)!; window.scrollBy(0, node.getBoundingClientRect().top - 20); }, focus.id);
        const before = (await row(page, focus).boundingBox())!.y;
        fixture.deliver();
        await expect(page.getByRole("region", { name: "Ancestor context" })).toContainText(root.content);
        await expect.poll(async () => Math.abs((await row(page, focus).boundingBox())!.y - before)).toBeLessThan(3);
    });
    test("moves an unresolved branch into place without losing expansion", async ({ context, page }) => {
        const orphanRoot = make("Orphan discussion focus");
        const missing = make("Late unpaid parent", [["e", orphanRoot.id, "", "root"]]);
        const orphan = make("Initially orphaned reply", [["e", orphanRoot.id, "", "root"], ["e", missing.id, "", "reply"]]);
        const grandchild = make("Preserved expanded descendant", [["e", orphanRoot.id, "", "root"], ["e", orphan.id, "", "reply"]]);
        const fixture = await setup(context, page, { focus: orphanRoot, events: [orphan, grandchild], slowParent: missing });
        await page.goto(`/discussion/${orphanRoot.id}`);
        await expect(page.getByRole("region", { name: "Unresolved branches" })).toContainText(orphan.content);
        await expect(row(page, grandchild)).toBeVisible();
        await expect.poll(fixture.hasDelivery).toBe(true);
        fixture.deliver();
        await drain(page);
        await expect(row(page, missing)).toBeVisible();
        await expect(row(page, orphan).getByRole("button", { name: "Hide replies" })).toHaveAttribute("aria-expanded", "true");
        await expect(row(page, grandchild)).toBeVisible();
        await row(page, missing).getByRole("button", { name: "Hide replies" }).click();
        await expect(row(page, grandchild)).toHaveCount(0);
        await page.reload();
        await drain(page);
        await expect(row(page, grandchild)).toHaveCount(0);
        await row(page, missing).getByRole("button", { name: "Show replies (1)" }).click();
        await page.reload();
        await drain(page);
        await expect(row(page, grandchild)).toBeVisible();
    });
    test("reads addressable NIP-22 comments without turning root scope into a parent", async ({ context, page }) => {
        const article = make("Original article text", [["d", "article"]], 1700000000, 30023);
        const address = `30023:${article.pubkey}:article`;
        const comment = make("Direct article comment", [["A", address], ["K", "30023"], ["P", article.pubkey], ["a", address], ["e", article.id], ["k", "30023"], ["p", article.pubkey]], 1700000100, 1111);
        const nested = make("Nested NIP-22 reply", [["A", address], ["K", "30023"], ["P", article.pubkey], ["e", comment.id], ["k", "1111"], ["p", comment.pubkey]], 1700000200, 1111);
        await setup(context, page, { focus: article, events: [comment, nested] });
        await page.goto(`/discussion/${article.id}`);
        await drain(page);
        await expect(row(page, article)).toContainText(article.content);
        await expect(row(page, comment)).toContainText(comment.content);
        await expect(row(page, nested)).toContainText(nested.content);
    });
    test("continues a broad parent-only tree without reserving every source upfront", async ({ context, page }) => {
        // Completing several bounded Load more batches can exceed the suite deadline.
        test.setTimeout(180000);
        const selected = make("Broad discussion root");
        const children = Array.from({ length: 70 }, (_, i) => make(`Broad child ${i}`, [["e", selected.id, "", "reply", selected.pubkey]], 1700000500 + i));
        const grandchildren = children.map((parent, i) => make(`Broad grandchild ${i}`, [["e", parent.id, "", "reply", parent.pubkey]], 1700000600 + i));
        const fixture = await setup(context, page, { focus: selected, events: [...children, ...grandchildren], board: [selected] });
        await page.goto(`/discussion/${selected.id}`);
        const coverage = page.getByRole("region", { name: "Discussion coverage" });
        await expect(coverage).toHaveAttribute("data-read-state", "paused", { timeout: 35000 });
        await coverage.getByText("Source details", { exact: true }).click();
        await expect(coverage).toContainText("additional source checks remain");
        await expect(coverage.getByRole("button", { name: "Load more", exact: true })).toBeEnabled();
        await drain(page);
        const heading = page.getByRole("region", { name: "Replies", exact: true }).getByRole("heading");
        expect(Number.parseInt((await heading.innerText()), 10)).toBeGreaterThanOrEqual(130);
        await expect(page.getByRole("region", { name: "Replies", exact: true }).locator("article")).toHaveCount(48);
        await expect(coverage).toContainText("Reading limits were reached");
        await expect(coverage.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
        const operations = Number.parseInt((await coverage.locator("details > p").first().innerText()), 10);
        expect(operations).toBeLessThanOrEqual(128);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(fixture.publications).toEqual([]);
    });
    test("bounds rendered replies and exposes the rest through local pages", async ({ context, page }) => {
        const selected = make("Many replies focus");
        await setup(context, page, { focus: selected, many: 55 });
        await page.goto(`/discussion/${selected.id}`);
        await expect(page.getByRole("heading", { name: "55 found replies" })).toBeVisible();
        const replies = page.getByRole("region", { name: "Replies", exact: true });
        await expect(replies.locator("article")).toHaveCount(48);
        await page.evaluate(() => document.fonts.ready);
        const first = replies.locator("article").first();
        // A 16px text line plus the author, parent and footer's 44px targets.
        await expect(first.locator(".note-text")).toHaveCSS("font-size", "16px");
        expect((await first.boundingBox())!.height).toBeLessThan(190);
        await expect(first.locator("[data-parent-preview]")).toHaveCount(0);
        const hitAreas = await first.locator(".discussion-actions a, .discussion-actions button, .discussion-parent").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
        expect(hitAreas.every(height => height >= 44)).toBe(true);
        const rails = await replies.locator("[data-discussion-key]").evaluateAll(nodes => nodes.slice(0, 2).map(node => {
            const line = node.querySelector("[data-branch-rail]")!.getBoundingClientRect();
            return { left: line.left, top: line.top, bottom: line.bottom };
        }));
        expect(Math.abs(rails[0].bottom - rails[1].top)).toBeLessThan(1);
        expect(rails[0].left).toBe(rails[1].left);
        await replies.getByRole("button", { name: "Next replies" }).click();
        await expect(replies).toBeFocused();
        expect((await replies.boundingBox())!.y).toBeGreaterThanOrEqual(0);
        await expect(replies.locator("article")).toHaveCount(7);
        await expect(replies).toContainText("Sibling 55");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
    test("jumps to a deep reply's exact parent on an earlier local page", async ({ context, page }) => {
        const selected = make("Deep discussion focus");
        const chain: Event[] = [];
        for (let i = 0; i < 53; i++) chain.push(make(`Deep message ${i + 1}`, [["e", selected.id, "", "root"], ["e", chain.at(-1)?.id ?? selected.id, "", "reply"]], 1700000500 + i));
        await setup(context, page, { focus: selected, events: chain });
        await page.goto(`/discussion/${selected.id}`);
        const replies = page.getByRole("region", { name: "Replies", exact: true });
        await expect(replies.locator("article")).toHaveCount(48);
        await expect(row(page, chain[47])).toBeVisible();
        await replies.getByRole("button", { name: "Next replies" }).click();
        await expect(replies).toContainText("Branch continued from the previous page.");
        await expect(row(page, chain[48])).toBeVisible();
        await expect(row(page, chain[48]).getByRole("link", { name: /Go to parent note by/ })).toContainText(chain[47].content);
        await row(page, chain[48]).getByRole("link", { name: /Go to parent note by/ }).click();
        await expect(row(page, chain[47])).toBeFocused();
        await expect(replies.locator("article")).toHaveCount(48);
        await replies.getByRole("button", { name: "Next replies" }).click();
        await expect(row(page, chain[48])).toBeVisible();
        await expect(row(page, chain[47])).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
    test("distinguishes the replying author from the parent and opens the selected subtree", async ({ context, page }) => {
        const otherKey = generateSecretKey();
        const response = finalizeEvent({ content: "A different author's response", tags: [["e", root.id, "", "root"], ["e", focus.id, "", "reply"]], created_at: 1700000400, kind: 1 }, otherKey);
        const otherProfile = finalizeEvent({ content: JSON.stringify({ name: "Another participant" }), tags: [], created_at: 1700000000, kind: 0 }, otherKey);
        await setup(context, page, { events: [response, otherProfile] });
        await page.goto(`/discussion/${focus.id}`);
        await drain(page);
        await expect(row(page, response).getByRole("link", { name: "Another participant", exact: true })).toBeVisible();
        await expect(row(page, response).getByRole("link", { name: "Go to parent note by Discussion author" })).toContainText("Replying to Discussion author");
        await expect(row(page, response).locator("[data-parent-preview]")).toHaveCount(0);
        await row(page, response).getByRole("link", { name: "Open thread", exact: true }).click();
        await expect(page.getByRole("article", { name: "Discussion focus" })).toContainText(response.content);
        await expect(page.getByRole("region", { name: "Ancestor context" })).toContainText(focus.content);
    });
    test("exposes a timeout as partial and retries without dropping found replies", async ({ context, page }) => {
        const options = { blockReplies: true };
        const fixture = await setup(context, page, options);
        await page.goto(`/discussion/${focus.id}`);
        const coverage = page.getByRole("region", { name: "Discussion coverage" });
        await expect(coverage).toHaveAttribute("data-read-state", "paused", { timeout: 15000 });
        await expect(coverage.getByRole("status").first()).toContainText("Partial results");
        await coverage.getByText("Source details", { exact: true }).click();
        await expect(coverage).toContainText("need retry");
        await expect(coverage).not.toContainText("unfinished queries");
        const sources = await coverage.locator("[data-source-relay]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-source-relay")));
        expect(sources.length).toBeGreaterThan(0);
        expect(new Set(sources).size).toBe(sources.length);
        await expect(row(page, child)).toContainText(child.content);
        options.blockReplies = false;
        await page.getByRole("button", { name: "Load more", exact: true }).click();
        await drain(page);
        await expect(coverage).toHaveAttribute("data-read-state", "settled");
        await expect(row(page, child)).toContainText(child.content);
        expect(fixture.publications).toEqual([]);
    });
    test("retains partial results and closes the pending query on navigation", async ({ context, page }) => {
        const fixture = await setup(context, page, { blockReplies: true });
        await page.goto(`/discussion/${focus.id}`);
        await expect.poll(() => fixture.blocked.size).toBeGreaterThan(0);
        await expect(row(page, child)).toContainText(child.content);
        await page.getByRole("link", { name: "Back to board" }).click();
        await expect.poll(() => [...fixture.blocked].every(id => fixture.closes.has(id))).toBe(true);
        await expect(page.getByRole("region", { name: "Discussion coverage" })).toHaveCount(0);
        expect(fixture.publications).toEqual([]);
    });
});
