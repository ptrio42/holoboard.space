import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { finalizeEvent, generateSecretKey, type Event } from "nostr-tools/pure";
import { neventEncode, noteEncode } from "nostr-tools/nip19";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });
const authorKey = generateSecretKey(), quoteKey = generateSecretKey();
const makeNote = (content: string, tags: string[][] = [], key = authorKey, kind = 1) =>
    finalizeEvent({ kind, created_at: 1700000000, content, tags }, key);
const quotes = Array.from({ length: 6 }, (_, i) => makeNote(`Quoted source ${i + 1}. ` + "Context for the original note. ".repeat(12), [], quoteKey));
const profiles = [makeNote(JSON.stringify({ name: "Row author" }), [], authorKey, 0), makeNote(JSON.stringify({ name: "Quote author" }), [], quoteKey, 0)];

async function setup(context: BrowserContext, page: Page, options: { content?: string; billboard?: boolean; tags?: string[][]; availableQuotes?: Event[]; expired?: boolean; ledger?: { rank?: number; sats_paid?: number; weight?: number }; slowQuote?: { deliver?: () => void; fastReplies: number } } = {}) {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const note = makeNote(options.content ?? "A billboard headline.\n" + quotes.map(quote => `nostr:${noteEncode(quote.id)}`).join("\n"), options.tags);
    const entry = { event: note, id: note.id, rank: 1, weight: 200, sats_paid: 210, first_paid_at: 1700000000, last_paid_at: 1700000000,
        hot_sats: 21, author_share: 20, ...options.ledger, ...(options.billboard !== false ? { billboard: { template: "poster", color: "cyan", size: "medium", speed: "normal", text: "A billboard headline." } } : {}) };
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.origin !== "http://127.0.0.1:3334") return route.abort();
        const data = url.pathname === "/api/board/waiting-updates" ? { count: 0, note_ids: [], checked_at: Date.now() } : url.pathname === "/api/board/expired" ? { entries: [entry] } :
            { entries: [entry], targets: [entry], total: 1, active_posts: 31, has_more: false, total_sats: 210 };
        return route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(data) });
    });
    await context.routeWebSocket("**/*", socket => {
        if (socket.url().startsWith(origin.replace(/^http/, "ws"))) return socket.connectToServer();
        socket.onMessage(message => {
            const msg = JSON.parse(String(message));
            if (msg[0] !== "REQ") return;
            if (options.slowQuote && msg.slice(2).some((filter: { ids?: string[] }) => filter.ids?.includes(quotes[0].id))) {
                if (socket.url().startsWith("wss://slow.example")) {
                    options.slowQuote.deliver = () => {
                        socket.send(JSON.stringify(["EVENT", msg[1], quotes[0]]));
                        socket.send(JSON.stringify(["EOSE", msg[1]]));
                    };
                } else {
                    options.slowQuote.fastReplies++;
                    socket.send(JSON.stringify(["EOSE", msg[1]]));
                }
                return;
            }
            for (const event of [...profiles, ...(options.availableQuotes ?? quotes)]) {
                if (msg.slice(2).some((filter: { ids?: string[]; kinds?: number[]; authors?: string[] }) =>
                    (!filter.ids || filter.ids.includes(event.id)) && (!filter.kinds || filter.kinds.includes(event.kind)) &&
                    (!filter.authors || filter.authors.includes(event.pubkey)))) socket.send(JSON.stringify(["EVENT", msg[1], event]));
            }
            socket.send(JSON.stringify(["EOSE", msg[1]]));
        });
    });
    await page.goto(options.expired ? "/expired" : "/");
    await expect(page.locator("article")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    return page.locator("article");
}

test("billboard options reveal complete quotes and original text from the compact footer", async ({ context, page }, testInfo) => {
    const row = await setup(context, page, { tags: [["e", quotes[0].id, "", "reply"]] });
    const sections = page.getByRole("navigation", { name: "Board sections" });
    await expect(sections.getByRole("link", { name: "TOP 21" })).toHaveAttribute("aria-current", "page");
    const waitingLink = page.getByRole("link", { name: "Waiting room (10)", exact: true });
    await expect(waitingLink).toHaveAttribute("href", "/waiting");
    expect(await waitingLink.evaluate(element => getComputedStyle(element.querySelector("span")!).fontFamily)).toContain("PressStart2P");
    expect((await waitingLink.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(row.locator(".note-quote__excerpt").first()).toContainText("Quoted source 1");
    await expect(row.getByText("In reply to quoted note", { exact: true })).toBeVisible();
    await expect(row.locator(".note-context")).toHaveCount(0);
    const options = row.getByRole("button", { name: "Note options", exact: true });
    await page.screenshot({ path: testInfo.outputPath("billboard-note.png"), fullPage: true });
    await expect(row.locator(".note-footer").getByRole("button", { name: "Note options", exact: true })).toBeVisible();
    await expect(row.locator(".note-footer").getByRole("button", { name: "Boost", exact: true })).toBeVisible();
    await expect.poll(() => row.locator(".note-quote[inert]").count()).toBeGreaterThan(0);
    const firstQuote = row.locator(".note-quote").first();
    expect(await firstQuote.evaluate(element => {
        const viewport = element.closest("[id]")!;
        return element.getBoundingClientRect().bottom <= viewport.getBoundingClientRect().bottom + 1;
    })).toBe(true);
    for (const control of [options, row.getByRole("button", { name: "Boost", exact: true }), firstQuote.getByRole("link", { name: "Open quoted note" })]) {
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await options.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Note options" });
    const original = menu.getByRole("menuitem", { name: "Read original", exact: true });
    await expect(original).toBeFocused();
    const external = menu.getByRole("menuitem", { name: "Open in njump", exact: true });
    await expect(external).toHaveAttribute("href", /^https:\/\/njump.me\/note1/);
    for (const control of [original, external]) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("ArrowDown");
    await expect(external).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(options).toBeFocused();
    await expect(menu).toHaveCount(0);
    await options.click();
    await original.click();
    await expect(row.getByText("Original text", { exact: true })).toBeVisible();
    await expect(row.locator(".note-quote[inert]")).toHaveCount(0);
    await expect(row.getByRole("link", { name: "Open quoted note" })).toHaveCount(6);
    await row.locator(".note-quote").last().scrollIntoViewIfNeeded();
    await expect(row.locator(".note-quote").last()).toContainText("Quoted source 6");
    await options.click();
    await menu.getByRole("menuitem", { name: "Hide original", exact: true }).click();
    await expect(row.getByText("Original text", { exact: true })).toHaveCount(0);
    await expect.poll(() => row.locator(".note-quote[inert]").count()).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await waitingLink.click();
    await page.waitForURL("**/waiting", { waitUntil: "domcontentloaded" });
    await expect(sections.getByRole("link", { name: "Waiting room", exact: true })).toHaveAttribute("aria-current", "page", { timeout: 15000 });
    await expect(page.getByRole("group", { name: "Waiting room sort" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Waiting room (10)", exact: true })).toHaveCount(0);
});

test("long plain notes restore hidden quote actions when expanded", async ({ context, page }) => {
    const row = await setup(context, page, { billboard: false, content: "A long paragraph.\n".repeat(24) + `nostr:${noteEncode(quotes[0].id)}` });
    await expect(row.locator(".note-quote")).toHaveAttribute("inert", "");
    await row.getByRole("button", { name: /Show more/ }).click();
    await expect(row.locator(".note-quote__excerpt")).toContainText("Quoted source 1");
    await expect(row.locator(".note-quote")).not.toHaveAttribute("inert");
    await row.getByRole("link", { name: "Open quoted note" }).focus();
    await expect(row.getByRole("link", { name: "Open quoted note" })).toBeFocused();
    await row.getByRole("button", { name: /Show less/ }).click();
    await expect(row.locator(".note-quote")).toHaveAttribute("inert", "");
});

test("timed-out quotes retain an accessible external link and can be retried", async ({ context, page }) => {
    await page.clock.install();
    const options = { content: `A billboard headline.\nnostr:${noteEncode(quotes[0].id)}`, availableQuotes: [] as Event[] };
    const row = await setup(context, page, options);
    await expect(row.getByText("Loading preview", { exact: false })).toBeVisible();
    await page.clock.runFor(31000);
    await expect(row.getByText("Preview timed out", { exact: true })).toBeVisible();
    const link = row.getByRole("link", { name: "Open quoted note" });
    await expect(link).toHaveAttribute("href", /^https:\/\/njump.me\/nevent1/);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveText("Open");
    // A normal board refresh must not silently start a new attempt after timeout.
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(row.getByText("Preview timed out", { exact: true })).toBeVisible();
    options.availableQuotes = [quotes[0]];
    await row.getByRole("button", { name: "Retry preview" }).click();
    await expect(row.locator(".note-quote__excerpt")).toContainText("Quoted source 1");
    await expect(row.getByText("Preview timed out", { exact: true })).toHaveCount(0);
});

test("fast empty relays do not mark a slower quoted note unavailable", async ({ context, page }) => {
    const slowQuote: { deliver?: () => void; fastReplies: number } = { fastReplies: 0 };
    const reference = neventEncode({ id: quotes[0].id, relays: ["wss://fast.example", "wss://slow.example"] });
    const row = await setup(context, page, { content: `Quoted context nostr:${reference}`, slowQuote });
    await expect.poll(() => slowQuote.fastReplies).toBeGreaterThanOrEqual(2);
    await expect.poll(() => !!slowQuote.deliver).toBe(true);
    // Allow NDK's early EOSE heuristic to run before the slow relay responds.
    await page.waitForTimeout(1200);
    await expect(row.getByText("Loading preview", { exact: false })).toBeVisible();
    await expect(row.getByText("Preview unavailable", { exact: true })).toHaveCount(0);
    slowQuote.deliver!();
    await expect(row.locator(".note-quote__excerpt")).toContainText("Quoted source 1");
    await expect(row.getByText("Preview unavailable", { exact: true })).toHaveCount(0);
    await expect(row.getByRole("link", { name: "Open quoted note" })).toBeVisible();
});

test("board refreshes do not restart an unfinished quote lookup", async ({ context, page }) => {
    const slowQuote: { deliver?: () => void; fastReplies: number } = { fastReplies: 0 };
    const reference = neventEncode({ id: quotes[0].id, relays: ["wss://fast.example", "wss://slow.example"] });
    const row = await setup(context, page, { billboard: false, content: `Quoted context nostr:${reference}`, slowQuote });
    await expect.poll(() => !!slowQuote.deliver).toBe(true);
    await page.waitForTimeout(200);
    const requestsBeforeRefresh = slowQuote.fastReplies;
    const refreshed = page.waitForResponse(response => response.url().includes("/campaigns"));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await refreshed;
    await page.waitForTimeout(300);
    expect(slowQuote.fastReplies).toBe(requestsBeforeRefresh);
    slowQuote.deliver!();
    await expect(row.locator(".note-quote__excerpt")).toContainText("Quoted source 1");
});

test("slow quotes keep their lookup open past the initial loading deadline", async ({ context, page }) => {
    await page.clock.install();
    const slowQuote: { deliver?: () => void; fastReplies: number } = { fastReplies: 0 };
    const reference = neventEncode({ id: quotes[0].id, relays: ["wss://fast.example", "wss://slow.example"] });
    const row = await setup(context, page, { content: `Quoted context nostr:${reference}`, slowQuote });
    await expect.poll(() => !!slowQuote.deliver).toBe(true);
    await page.clock.runFor(8100);
    await expect(row.getByText("Preview unavailable", { exact: true })).toHaveCount(0);
    await expect(row.getByRole("status")).toContainText("Still loading preview");
    const requestsBeforeRefresh = slowQuote.fastReplies;
    await page.clock.runFor(7500);
    await expect(row.getByRole("status")).toContainText("Still loading preview");
    expect(slowQuote.fastReplies).toBe(requestsBeforeRefresh);
    slowQuote.deliver!();
    await expect(row.locator(".note-quote__excerpt")).toContainText("Quoted source 1");
});

test("previously loaded quotes remain readable when relays no longer return them", async ({ context, page }) => {
    await page.clock.install();
    const options = { content: `Cached context nostr:${noteEncode(quotes[0].id)}`, availableQuotes: [quotes[0]] };
    const row = await setup(context, page, options);
    await expect(row.locator(".note-quote__excerpt")).toContainText("Quoted source 1");
    // The bounded read cache persists its pending writes after two seconds.
    await page.clock.runFor(3000);
    await expect.poll(() => page.evaluate(id => new Promise<boolean>((resolve, reject) => {
        const open = indexedDB.open("holoboard-nostr-read-v1");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const database = open.result;
            const transaction = database.transaction("events");
            const get = transaction.objectStore("events").get(id);
            get.onsuccess = () => resolve(!!get.result);
            get.onerror = () => reject(get.error);
            transaction.oncomplete = () => database.close();
        };
    }), quotes[0].id)).toBe(true);
    options.availableQuotes = [];
    await page.reload();
    await expect(row.locator(".note-quote__excerpt")).toContainText("Quoted source 1");
    await expect(row.getByRole("status")).toHaveCount(0);
});

test("short replies keep conversation context near the author", async ({ context, page }) => {
    const row = await setup(context, page, { billboard: false, content: "A short reply.", tags: [["e", quotes[0].id, "", "reply"]] });
    const contextLink = row.getByRole("link", { name: /In reply to/ });
    await expect(contextLink).toHaveAttribute("href", `https://njump.me/${noteEncode(quotes[0].id)}`);
    await expect(row.locator(".board-identity").getByRole("link", { name: /In reply to/ })).toBeVisible();
    await expect(row.getByRole("button", { name: /Show more|Show original/ })).toHaveCount(0);
    expect((await contextLink.boundingBox())!.y).toBeGreaterThan((await row.locator(".board-author").boundingBox())!.y);
});

test("expired notes retain their historical payment and promotion action", async ({ context, page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    const row = await setup(context, page, { expired: true, billboard: false, content: "An expired paragraph.\n".repeat(24) });
    await expect(page.getByRole("heading", { name: "HOLOBOARD", exact: true })).toBeVisible();
    const sections = page.getByRole("navigation", { name: "Board sections" });
    await expect(sections.getByRole("link", { name: "Expired", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(sections.getByRole("link", { name: "TOP 21" })).toHaveAttribute("href", "/");
    await expect(sections.getByRole("link", { name: "Waiting room" })).toHaveAttribute("href", "/waiting");
    await expect(page.getByRole("navigation", { name: "Connections" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Promote a note", exact: true })).toBeVisible();
    await expect(page.locator("footer").getByRole("link", { name: "Help" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Promote again", exact: true })).toBeVisible();
    await expect(row.locator(".board-rank, .board-weight__track")).toHaveCount(0);
    await row.getByRole("button", { name: /210 sats paid, no longer counting/ }).click();
    const details = page.getByRole("dialog", { name: "Ranking weight" });
    await expect(details).toContainText("No longer counting");
    await expect(details).toContainText("210 sats");
    await expect(details).not.toContainText("Remaining weight");
    await page.getByRole("button", { name: "Close ranking weight" }).click();
    await row.getByRole("button", { name: "Note options", exact: true }).click();
    await expect(page.getByText(/Last payment:/)).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Open in njump", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await row.getByRole("button", { name: /Show more/ }).click();
    await expect(row.getByRole("button", { name: /Show less/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("gold sats open ranking details without crowding the author or Boost", async ({ context, page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 800 });
    const row = await setup(context, page, { billboard: false, content: "A simple note, with every line using the same text style.\nMore space for the message." });
    const amount = row.getByRole("button", { name: "200 sats counting, 210 sats paid in total", exact: true });
    const boost = row.getByRole("button", { name: "Boost", exact: true });
    const author = row.locator(".board-author");
    await expect(author).toContainText("Row author");
    expect((await author.locator("[aria-hidden=true]").boundingBox())!.width).toBe(24);
    for (const control of [author, amount, boost, row.getByRole("button", { name: "Note options", exact: true })]) {
        const box = (await control.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.width).toBeGreaterThanOrEqual(44);
    }
    expect((await amount.boundingBox())!.x + (await amount.boundingBox())!.width).toBeLessThanOrEqual((await boost.boundingBox())!.x);
    await expect(amount).toHaveCSS("color", "rgb(251, 191, 36)");
    await expect(row.locator(".board-note-content .note-body")).toHaveCSS("font-size", "14px");
    await expect(row.locator(".board-note-content h1, .board-note-content h2")).toHaveCount(0);
    await expect(row.locator(".board-rank__label")).toHaveText("TOP");
    await page.screenshot({ path: testInfo.outputPath("compact-note.png"), fullPage: true });
    await amount.click();
    const details = page.getByRole("dialog", { name: "Ranking weight" });
    await expect(details).toContainText("Counting today200 sats");
    await expect(details).toContainText("Paid for visibility210 sats");
    await expect(details).toContainText("95% still counts");
    const bounds = (await details.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    await page.screenshot({ path: testInfo.outputPath("ranking-weight.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(amount).toBeFocused();
    await expect(details).toHaveCount(0);
    await amount.click();
    // At narrow widths the details panel can cover the complete note body.
    await page.mouse.click(8, 780);
    await expect(details).toHaveCount(0);
    await boost.click();
    await expect(page.getByRole("dialog", { name: "Boost note", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const rank of [2, 3, 21]) {
    test(`rank ${rank} stays compact beside ordinary note text`, async ({ context, page }) => {
        await page.setViewportSize({ width: 320, height: 800 });
        const row = await setup(context, page, { billboard: false, content: "A readable opening sentence.\nA second line.", ledger: { rank } });
        await expect(row.locator(".board-rank__number")).toHaveText(String(rank));
        await expect(row.locator(".board-rank__label")).toHaveCount(0);
        expect(await row.locator(".board-note-content .note-body").evaluate(body => {
            const text = [...body.childNodes].find(node => node.nodeType === Node.TEXT_NODE)!;
            const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 1);
            const letter = range.getBoundingClientRect(), rank = body.parentElement!.querySelector(".board-rank")!.getBoundingClientRect();
            return letter.right <= rank.left && letter.top < rank.bottom;
        })).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
}

for (const weight of [210, 8]) {
    test(`weight ${weight} preserves the paid total and its fade state`, async ({ context, page }) => {
        const row = await setup(context, page, { billboard: false, content: "A note with a changing ranking weight.", ledger: { weight } });
        const amount = row.locator(".board-weight");
        const ratio = await amount.locator(".board-weight__track").evaluate(track => track.firstElementChild!.getBoundingClientRect().width / track.getBoundingClientRect().width);
        expect(ratio).toBeCloseTo(weight / 210, 2);
        await amount.click();
        const details = page.getByRole("dialog", { name: "Ranking weight" });
        await expect(details).toContainText("Paid for visibility210 sats");
        await expect(details).toContainText(`${Math.round(weight / 210 * 100)}% still counts`);
    });
}

test("large amounts wrap without losing the avatar or note options", async ({ context, page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 800 });
    const row = await setup(context, page, { billboard: false, content: "A short note.", ledger: { sats_paid: 987654321, weight: 987654321 } });
    await expect(row.locator(".board-author")).toContainText("Row author");
    const amount = row.locator(".board-weight");
    expect((await amount.boundingBox())!.y).toBeGreaterThan((await row.locator(".board-author").boundingBox())!.y);
    await amount.click();
    await expect(page.getByRole("dialog", { name: "Ranking weight" })).toContainText("987,654,321 sats");
    await page.keyboard.press("Escape");
    await row.getByRole("button", { name: "Note options", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Open in njump", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Read original", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("large-amount-options.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("note images retain the full content width below the inline rank", async ({ context, page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("https://example.com/banner.png", route => route.fulfill({ contentType: "image/webp", path: new URL("../src/assets/bg.webp", import.meta.url).pathname }));
    const row = await setup(context, page, { billboard: false, content: "An image note with a short introduction.\nhttps://example.com/banner.png" });
    const picture = row.locator(".board-note-content .note-body > img");
    await expect(picture).toBeVisible();
    await expect.poll(() => picture.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const imageBounds = (await picture.boundingBox())!, rankBounds = (await row.locator(".board-rank").boundingBox())!;
    expect(imageBounds.y).toBeGreaterThanOrEqual(rankBounds.y + rankBounds.height);
    expect(imageBounds.width).toBeCloseTo((await row.locator(".board-note-content").boundingBox())!.width, 0);
    await page.screenshot({ path: testInfo.outputPath("image-note.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
