import { test, expect, type BrowserContext, type Page, type Route } from "@playwright/test";
import { finalizeEvent, generateSecretKey, type Event } from "nostr-tools/pure";
import { neventEncode, noteEncode, nprofileEncode } from "nostr-tools/nip19";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });
const authorKey = generateSecretKey(), quoteKey = generateSecretKey();
const makeNote = (content: string, tags: string[][] = [], key = authorKey, kind = 1) =>
    finalizeEvent({ kind, created_at: 1700000000, content, tags }, key);
const quotes = Array.from({ length: 6 }, (_, i) => makeNote(`Quoted source ${i + 1}. ` + "Context for the original note. ".repeat(12), [], quoteKey));
const profiles = [makeNote(JSON.stringify({ name: "Row author" }), [], authorKey, 0), makeNote(JSON.stringify({ name: "Quote author" }), [], quoteKey, 0)];

interface PreviewFixture { requests: number; title: string; description?: string; image_url?: string; pending?: Route[]; unavailable?: boolean }
async function setup(context: BrowserContext, page: Page, options: { content?: string; billboard?: boolean; billboardText?: string; tags?: string[][]; availableQuotes?: Event[]; expired?: boolean; ledger?: { rank?: number; sats_paid?: number; weight?: number }; slowQuote?: { deliver?: () => void; fastReplies: number }; profileEose?: { releases: (() => void)[] }; hintProfile?: { relay: string; requests: number }; preview?: PreviewFixture } = {}) {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const note = makeNote(options.content ?? "A billboard headline.\n" + quotes.map(quote => `nostr:${noteEncode(quote.id)}`).join("\n"), options.tags);
    const entry = { event: note, id: note.id, rank: 1, weight: 200, sats_paid: 210, first_paid_at: 1700000000, last_paid_at: 1700000000,
        hot_sats: 21, author_share: 20, ...options.ledger, ...(options.billboard !== false ? { billboard: { template: "poster", color: "cyan", size: "medium", speed: "normal", text: options.billboardText ?? "A billboard headline." } } : {}) };
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.origin !== "http://127.0.0.1:3334") return route.abort();
        if (url.pathname === "/api/link-preview" && options.preview) {
            options.preview.requests++;
            if (options.preview.pending) { options.preview.pending.push(route); return; }
            return route.fulfill({ status: options.preview.unavailable ? 404 : 200, json: { ...options.preview, url: url.searchParams.get("url") } });
        }
        const data = url.pathname === "/api/board/waiting-updates" ? { count: 0, note_ids: [], checked_at: Date.now() } : url.pathname === "/api/board/expired" ? { entries: [entry] } :
            { entries: [entry], targets: [entry], total: 1, active_posts: 31, has_more: false, total_sats: 210 };
        return route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(data) });
    });
    await context.routeWebSocket("**/*", socket => {
        if (socket.url().startsWith(origin.replace(/^http/, "ws"))) return socket.connectToServer();
        socket.onMessage(message => {
            const msg = JSON.parse(String(message));
            if (msg[0] !== "REQ") return;
            if (options.hintProfile && socket.url().startsWith(options.hintProfile.relay) &&
                msg.slice(2).some((filter: { kinds?: number[]; authors?: string[] }) => filter.kinds?.includes(0) && filter.authors?.includes(profiles[1].pubkey))) options.hintProfile.requests++;
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
                if (options.hintProfile && event.id === profiles[1].id && !socket.url().startsWith(options.hintProfile.relay)) continue;
                if (msg.slice(2).some((filter: { ids?: string[]; kinds?: number[]; authors?: string[] }) =>
                    (!filter.ids || filter.ids.includes(event.id)) && (!filter.kinds || filter.kinds.includes(event.kind)) &&
                    (!filter.authors || filter.authors.includes(event.pubkey)))) socket.send(JSON.stringify(["EVENT", msg[1], event]));
            }
            const end = () => socket.send(JSON.stringify(["EOSE", msg[1]]));
            if (options.profileEose && msg.slice(2).some((filter: { kinds?: number[] }) => filter.kinds?.includes(0))) options.profileEose.releases.push(end);
            else end();
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
    await expect(row.locator(".note-quote")).toHaveCount(6);
    await expect(row.locator(".note-quote[inert]")).toHaveCount(0);
    const firstQuote = row.locator(".note-quote").first();
    for (const control of [options, row.getByRole("button", { name: "Boost", exact: true }), firstQuote.getByRole("link", { name: "Open quoted note" })]) {
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await options.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Note options" });
    const original = menu.getByRole("menuitem", { name: "Read original", exact: true });
    await expect(original).toBeFocused();
    const external = menu.getByRole("menuitem", { name: "Open in njump", exact: true });
    await expect(external).toHaveAttribute("href", /^https:\/\/njump.me\/nevent1/);
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
    await expect(row.locator(".note-quote[inert]")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await waitingLink.click();
    await page.waitForURL("**/waiting", { waitUntil: "domcontentloaded" });
    await expect(sections.getByRole("link", { name: "Waiting room", exact: true })).toHaveAttribute("aria-current", "page", { timeout: 15000 });
    await expect(page.getByRole("group", { name: "Waiting room sort" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Waiting room (10)", exact: true })).toHaveCount(0);
});

test("billboard mentions resolve profiles from their nprofile relay hints", async ({ context, page }) => {
    const hintProfile = { relay: "wss://mention-only.example", requests: 0 };
    const text = `Respect to nostr:${nprofileEncode({ pubkey: profiles[1].pubkey, relays: [hintProfile.relay] })}`;
    const row = await setup(context, page, { content: text, billboardText: text, hintProfile });
    await expect(row.locator(".billboard-screen").getByRole("link", { name: "@Quote author", exact: true })).toBeVisible();
    expect(hintProfile.requests).toBeGreaterThan(0);
    await expect(row.locator(".board-original")).toHaveCount(0);
});

for (const width of [320, 390, 1440]) test(`billboards share the adaptive quote gallery at ${width}px without resetting media`, async ({ context, page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("https://example.com/billboard-photo-*.png", route => route.fulfill({ contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1920"><rect width="1440" height="1920" fill="#22d3ee"/></svg>' }));
    const quote = makeNote("Quoted context. ".repeat(40) + "\n" + [1, 2, 3].map(index => `https://example.com/billboard-photo-${index}.png`).join("\n"), [], quoteKey);
    const row = await setup(context, page, { content: `Signed opening.\nnostr:${noteEncode(quote.id)}`, availableQuotes: [quote] });
    const presentation = row.locator(".note-composition-presentation");
    const media = row.locator(".note-composition-media");
    const gallery = media.locator(".note-gallery");
    await expect(gallery).toHaveClass(/gallery-portraits/);
    await expect(gallery.getByRole("button")).toHaveCount(3);
    const leadBounds = (await presentation.boundingBox())!, mediaBounds = (await media.boundingBox())!;
    if (width === 1440) expect(mediaBounds.x).toBeGreaterThanOrEqual(leadBounds.x + leadBounds.width);
    else expect(mediaBounds.y).toBeGreaterThanOrEqual(leadBounds.y + leadBounds.height);
    const image = await gallery.locator("img").first().elementHandle();
    const billboard = await presentation.locator(".billboard-screen").elementHandle();
    await media.getByRole("button", { name: "Show more quoted note text", exact: true }).click();
    await row.getByRole("button", { name: "Note options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Read original", exact: true }).click();
    await expect(row.locator(".board-original")).toContainText("Signed opening.");
    expect(await image!.evaluate(element => element.isConnected)).toBe(true);
    expect(await billboard!.evaluate(element => element.isConnected)).toBe(true);
    await expect(media.getByRole("button", { name: "Show less quoted note text", exact: true })).toBeVisible();
    await row.getByRole("button", { name: "Note options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Hide original", exact: true }).click();
    await expect(row.locator(".board-original")).toHaveCount(0);
    expect(await image!.evaluate(element => element.isConnected)).toBe(true);
    await gallery.getByRole("button", { name: "Open image 1 of 3", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Image 1 of 3", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(gallery.getByRole("button", { name: "Open image 1 of 3", exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("plain text and quoted text expand independently before the footer", async ({ context, page }) => {
    const row = await setup(context, page, { billboard: false, content: "A long paragraph.\n".repeat(24) + `nostr:${noteEncode(quotes[0].id)}` });
    const main = row.locator('[data-note-text="main"]');
    const quote = row.locator(".note-quote");
    await expect(quote.locator(".note-quote__excerpt")).toContainText("Quoted source 1");
    await expect(quote).not.toHaveAttribute("inert");
    await expect(row.locator(".note-footer button[aria-controls]").filter({ hasText: "Read" })).toHaveCount(0);
    const before = await main.locator(".note-text-content").innerText();
    await quote.getByRole("button", { name: "Show more quoted note text", exact: true }).click();
    await expect(quote.getByRole("button", { name: "Show less quoted note text", exact: true })).toBeVisible();
    expect(await main.locator(".note-text-content").innerText()).toBe(before);
    await main.getByRole("button", { name: "Show more note text", exact: true }).click();
    expect((await main.locator(".note-text-content").innerText()).length).toBeGreaterThan(before.length);
    await expect(quote.getByRole("button", { name: "Show less quoted note text", exact: true })).toBeVisible();
    const less = main.getByRole("button", { name: "Show less note text", exact: true });
    expect(await less.evaluate(button => {
        const block = button.closest(".note-text")!;
        return block.querySelector(".note-text-content")!.nextElementSibling === button.parentElement &&
            block.getBoundingClientRect().bottom <= block.closest("article")!.querySelector("footer")!.getBoundingClientRect().top;
    })).toBe(true);
    await less.focus(); await page.keyboard.press("Enter");
    await expect(main.getByRole("button", { name: "Show more note text", exact: true })).toBeFocused();
    await expect(quote.getByRole("button", { name: "Show less quoted note text", exact: true })).toBeVisible();
});

test("note option hints stay dismissed after closing or choosing a menu item", async ({ context, page }) => {
    const row = await setup(context, page, { content: "The original note behind a billboard." });
    const options = row.getByRole("button", { name: "Note options", exact: true });
    const hint = options.locator("..").locator(".board-hint");
    await options.focus();
    await expect(hint).toHaveCSS("opacity", "1");
    await page.keyboard.press("Enter");
    await expect(hint).toHaveCSS("opacity", "0");
    await page.keyboard.press("Escape");
    await expect(options).toBeFocused();
    await expect(hint).toHaveCSS("opacity", "0");
    await options.click();
    await page.getByRole("menuitem", { name: "Read original", exact: true }).click();
    await expect(row.getByText("Original text", { exact: true })).toBeVisible();
    await expect(hint).toHaveCSS("opacity", "0");
    await options.click();
    await expect(page.getByRole("menu", { name: "Note options" })).toBeVisible();
    await expect(options).toHaveAttribute("aria-expanded", "true");
    await options.click();
    await expect(page.getByRole("menu", { name: "Note options" })).toHaveCount(0);
    await expect(options).toBeFocused();
    await expect(hint).toHaveCSS("opacity", "0");
});

test("author names appear before slow profile relays finish and release their read handles", async ({ context, page }) => {
    const profileEose = { releases: [] as (() => void)[] };
    const row = await setup(context, page, { billboard: false, content: "A readable note with streamed author metadata.", profileEose });
    await expect(row.locator(".board-author")).toContainText("Row author", { timeout: 2000 });
    expect(profileEose.releases.length).toBeGreaterThan(0);
    expect(await page.evaluate(async () => (await import("/src/lib/profileReads.ts")).profileReader.stats().handles)).toBeGreaterThan(0);
    profileEose.releases.forEach(end => end());
    await expect.poll(() => page.evaluate(async () => (await import("/src/lib/profileReads.ts")).profileReader.stats().handles)).toBe(0);
    await expect(row.locator(".board-author")).toContainText("Row author");
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
    await expect(contextLink).toHaveAttribute("href", `https://njump.me/${neventEncode({ id: quotes[0].id })}`);
    await expect(row.locator(".board-identity").getByRole("link", { name: /In reply to/ })).toBeVisible();
    await expect(row.getByRole("button", { name: /Show more|Show original/ })).toHaveCount(0);
    expect((await contextLink.boundingBox())!.y).toBeGreaterThan((await row.locator(".board-author").boundingBox())!.y);
});

test("expired notes retain their historical payment and promotion action", async ({ context, page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    const row = await setup(context, page, { expired: true, billboard: false, content: "An expired paragraph.\n".repeat(24) });
    await expect(page.getByRole("heading", { name: "HOLOBOARD", exact: true })).toBeVisible();
    const sections = page.getByRole("navigation", { name: "Board sections" });
    await expect(sections.getByRole("link", { name: /Expired/ })).toHaveCount(0);
    await expect(page.getByRole("contentinfo").getByRole("link", { name: "Expired notes", exact: true })).toHaveAttribute("aria-current", "page");
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
    await expect(row.locator(".board-note-content .note-body")).toHaveCSS("font-size", "18px");
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
            const text = document.createTreeWalker(body.querySelector(".note-text-content")!, NodeFilter.SHOW_TEXT).nextNode()!;
            const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 1);
            const letter = range.getBoundingClientRect(), rank = body.closest(".board-note-content")!.querySelector(".board-rank")!.getBoundingClientRect();
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
    const picture = row.locator(".board-note-content .note-gallery-image img");
    await expect(picture).toBeVisible();
    await expect.poll(() => picture.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const imageBounds = (await picture.boundingBox())!, rankBounds = (await row.locator(".board-rank").boundingBox())!;
    expect(imageBounds.y).toBeGreaterThanOrEqual(rankBounds.y + rankBounds.height);
    expect(imageBounds.width).toBeCloseTo((await row.locator(".board-note-content").boundingBox())!.width, 0);
    await page.screenshot({ path: testInfo.outputPath("image-note.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const width of [320, 390, 1440]) test(`inline reading preserves media and fits the final text line at ${width}px`, async ({ context, page }) => {
    await page.setViewportSize({ width, height: 900 });
    const content = "A clear opening with enough text to require expansion. ".repeat(30) + "\nhttps://example.com/play.webm";
    const row = await setup(context, page, { billboard: false, content });
    const main = row.locator('[data-note-text="main"]');
    const more = main.getByRole("button", { name: "Show more note text", exact: true });
    await expect(more).toBeVisible();
    expect(await more.evaluate(button => {
        const block = button.closest(".note-text")!;
        const last = block.querySelector(".note-text-content > span:not([hidden]):last-of-type") ?? [...block.querySelectorAll(".note-text-content > span:not([hidden])")].at(-1)!;
        const range = document.createRange(); range.selectNodeContents(last);
        const line = [...range.getClientRects()].filter(rect => rect.width > 0).at(-1)!;
        const box = button.getBoundingClientRect();
        return Math.abs((line.top + line.bottom - box.top - box.bottom) / 2) < parseFloat(getComputedStyle(block).lineHeight) / 2;
    })).toBe(true);
    const video = await row.locator("video").elementHandle();
    await more.evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
    const scroll = await page.evaluate(() => scrollY);
    await more.click();
    expect(await video!.evaluate(element => element.isConnected)).toBe(true);
    expect(await main.locator(".note-text-content").innerText()).toBe(content.replace(/\nhttps:\/\/example.com\/play.webm$/, "").trimEnd());
    expect(Math.abs(await page.evaluate(() => scrollY) - scroll)).toBeLessThanOrEqual(1);
    const less = main.getByRole("button", { name: "Show less note text", exact: true });
    expect(await less.evaluate(button => {
        const block = button.closest(".note-text")!;
        const range = document.createRange(); range.selectNodeContents(block.querySelector(".note-text-content")!);
        const last = [...range.getClientRects()].filter(rect => rect.width > 0).at(-1)!;
        return button.getBoundingClientRect().top - last.bottom <= parseFloat(getComputedStyle(block).lineHeight);
    })).toBe(true);
    await less.focus(); await page.keyboard.press("Space");
    await expect(more).toBeFocused();
    expect((await more.boundingBox())!.y).toBeGreaterThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("short notes use larger full-width text without disclosure or invented headings", async ({ context, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const content = "CoMaps is better for everybody. ".repeat(8).trim();
    const row = await setup(context, page, { billboard: false, content });
    const text = row.locator('[data-note-text="main"]');
    await expect(text).toHaveCSS("font-size", "20px");
    expect(await text.locator(".note-text-content").innerText()).toBe(content);
    await expect(text.getByRole("button")).toHaveCount(0);
    expect((await text.boundingBox())!.width).toBeCloseTo((await row.locator(".board-note-content").boundingBox())!.width, 0);
    await expect(row.locator(".board-note-content h1, .board-note-content h2")).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(text).toHaveCSS("font-size", "16px");
    expect(await text.locator(".note-text-content").innerText()).toBe(content);
});

test("link cards fit below text beside media and keep one instance across phone layouts", async ({ context, page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route("https://example.com/*.png", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#164e63"/></svg>' }));
    const preview = { requests: 0, title: "The promoted destination", description: "Find out more about this project.", image_url: "https://example.com/thumbnail.png" };
    const row = await setup(context, page, { billboard: false, content: "A short campaign introduction.\nhttps://example.com/project\nhttps://example.com/photo.png", preview });
    const composition = row.locator(".note-composition");
    const text = row.locator('[data-note-text="main"]'), media = row.locator(".note-composition-media"), link = row.locator(".note-link-preview");
    await expect(composition).toHaveAttribute("data-link-placement", "text");
    const card = await link.elementHandle(), image = await media.locator("img").elementHandle();
    for (const width of [1440, 768, 390, 320, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(async () => {
            const t = (await text.boundingBox())!, m = (await media.boundingBox())!, l = (await link.boundingBox())!;
            if (width >= 768) {
                expect(l.x).toBeCloseTo(t.x, 0); expect(l.y).toBeGreaterThanOrEqual(t.y + t.height);
                expect(l.y + l.height).toBeLessThanOrEqual(m.y + m.height + 1);
                expect(m.x).toBeGreaterThan(l.x + l.width);
            } else {
                expect(m.y).toBeGreaterThanOrEqual(t.y + t.height);
                expect(l.y).toBeGreaterThanOrEqual(m.y + m.height);
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }).toPass();
        expect(await card!.evaluate(element => element.isConnected)).toBe(true);
        expect(await image!.evaluate(element => element.isConnected)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`link-placement-${width}.png`), fullPage: true });
    }
    expect(preview.requests).toBe(1);
});

test("link placement follows late metadata and local text expansion without restarting media", async ({ context, page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.route("https://example.com/photo.png", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#164e63"/></svg>' }));
    const preview: PreviewFixture = { requests: 0, title: "Project details", pending: [] };
    const row = await setup(context, page, { billboard: false, content: "A long campaign paragraph with useful information. ".repeat(50) + `\nhttps://example.com/project\nhttps://example.com/photo.png\nnostr:${noteEncode(quotes[0].id)}`, preview });
    await expect(row.locator(".note-quote__excerpt")).toContainText("Quoted source 1");
    await expect(row.locator(".note-quote__excerpt")).toHaveCSS("font-size", "14px");
    await expect.poll(() => preview.pending!.length).toBe(1);
    await preview.pending![0].fulfill({ json: { url: "https://example.com/project", title: preview.title } });
    const composition = row.locator(".note-composition");
    await expect(composition).toHaveAttribute("data-link-placement", "text");
    const card = await row.locator(".note-composition > .note-link-container .note-link-preview").elementHandle();
    const image = await row.locator(".note-composition-media > .note-gallery img").elementHandle();
    const before = await image!.boundingBox();
    const main = row.locator('[data-note-text="main"]');
    await main.getByRole("button", { name: "Show more note text", exact: true }).click();
    await expect(composition).toHaveAttribute("data-link-placement", "media");
    expect(await image!.evaluate(element => element.isConnected)).toBe(true);
    expect(await image!.boundingBox()).toEqual(before);
    expect(await card!.evaluate(element => element.isConnected)).toBe(true);
    await main.getByRole("button", { name: "Show less note text", exact: true }).click();
    await expect(composition).toHaveAttribute("data-link-placement", "text");
    expect(await row.locator(".note-composition > .note-link-container .note-link-preview").count()).toBe(1);
    expect(preview.requests).toBe(1);
});

test("long text keeps its link below media", async ({ context, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route("https://example.com/photo.png", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#164e63"/></svg>' }));
    const preview = { requests: 0, title: "Project details", description: "A longer destination description that needs another line in the available column." };
    const row = await setup(context, page, { billboard: false, content: "A longer campaign paragraph with important details. ".repeat(40) + "\nhttps://example.com/project\nhttps://example.com/photo.png", preview });
    await expect(row.locator(".note-composition")).toHaveAttribute("data-link-placement", "media");
    const m = (await row.locator(".note-composition-media").boundingBox())!, l = (await row.locator(".note-link-preview").boundingBox())!;
    expect(l.x).toBeCloseTo(m.x, 0); expect(l.y).toBeGreaterThanOrEqual(m.y + m.height);
});

test("unavailable link-only previews do not reserve an empty desktop column", async ({ context, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const row = await setup(context, page, { billboard: false, content: "Read about this project. https://example.com/unavailable", preview: { requests: 0, title: "Unavailable", unavailable: true } });
    await expect(row.locator('.note-link-container[data-preview-state="unavailable"]')).toBeAttached();
    await expect(row.locator(".note-composition")).toHaveCSS("display", "flex");
    const text = (await row.locator('[data-note-text="main"]').boundingBox())!, content = (await row.locator(".board-note-content").boundingBox())!;
    expect(text.width).toBeCloseTo(content.width, 0);
});

test("complete short text sits centrally beside media and stacks above it on phones", async ({ context, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route("https://example.com/photo.png", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#164e63"/></svg>' }));
    const row = await setup(context, page, { billboard: false, content: "An invitation to explore.\nhttps://example.com/photo.png" });
    const text = row.locator('[data-note-text="main"]'), media = row.locator(".note-composition-media");
    const t = (await text.boundingBox())!, m = (await media.boundingBox())!;
    expect(Math.abs(t.y + t.height / 2 - m.y - m.height / 2)).toBeLessThan(1);
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(async () => {
        const stacked = (await text.boundingBox())!, image = (await media.boundingBox())!;
        expect(stacked.y + stacked.height).toBeLessThanOrEqual(image.y);
        expect(stacked.width).toBeCloseTo((await row.locator(".board-note-content").boundingBox())!.width, 0);
    }).toPass();
});

test("link-only previews keep their media column when a thumbnail fails", async ({ context, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route("https://example.com/broken.png", route => route.abort());
    const preview = { requests: 0, title: "The campaign destination", image_url: "https://example.com/broken.png" };
    const row = await setup(context, page, { billboard: false, content: "Read about this project. https://example.com/project", preview });
    const link = row.locator(".note-link-preview"), text = row.locator('[data-note-text="main"]');
    await expect(link).toBeVisible(); await expect(link.locator("img")).toHaveCount(0);
    expect((await link.boundingBox())!.x).toBeGreaterThanOrEqual((await text.boundingBox())!.x + (await text.boundingBox())!.width);
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(async () => expect((await link.boundingBox())!.y).toBeGreaterThanOrEqual((await text.boundingBox())!.y + (await text.boundingBox())!.height)).toPass();
    expect(preview.requests).toBe(1);
});

test("portrait galleries preserve complete frames and provide every available image", async ({ context, page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("https://example.com/photo-*.png", route => route.request().url().endsWith("photo-4.png") ? route.abort() : route.fulfill({
        contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1920"><rect width="1440" height="1920" fill="#22d3ee"/></svg>',
    }));
    const row = await setup(context, page, { billboard: false, content: "A gallery of portrait images.\n" + [1, 2, 3, 4].map(index => `https://example.com/photo-${index}.png`).join("\n") });
    const gallery = row.locator(".note-gallery");
    expect(await row.locator('[data-note-text="main"] .note-text-content').innerText()).toBe("A gallery of portrait images.");
    await expect(gallery).toHaveClass(/gallery-portraits/);
    await expect(gallery.getByRole("button")).toHaveCount(3);
    for (const image of await gallery.locator("img").all()) {
        await expect(image).toHaveCSS("object-fit", "contain");
        const bounds = (await image.boundingBox())!;
        expect(bounds.width / bounds.height).toBeCloseTo(0.75, 2);
    }
    const first = gallery.getByRole("button", { name: "Open image 1 of 3", exact: true });
    await first.click();
    const viewer = page.getByRole("dialog", { name: "Image 1 of 3", exact: true });
    await expect(viewer).toBeVisible();
    await expect(viewer.locator(".note-image-viewer__image")).toHaveCSS("object-fit", "contain");
    await viewer.getByRole("button", { name: "Next image", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Image 2 of 3", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(first).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("adaptive-gallery.png"), fullPage: true });
});

test("unsafe markup stays text and hidden links cannot receive focus", async ({ context, page }) => {
    const row = await setup(context, page, { billboard: false, content: "<script>window.injected=true</script> " + "Ordinary words. ".repeat(60) + "https://example.com/final-destination" });
    const main = row.locator('[data-note-text="main"]');
    await expect(main.locator("script")).toHaveCount(0);
    const link = main.getByRole("link", { includeHidden: true });
    await expect(link).toBeHidden();
    await main.getByRole("button", { name: "Show more note text", exact: true }).click();
    await expect(link).toHaveAttribute("href", "https://example.com/final-destination");
    await link.focus(); await expect(link).toBeFocused();
    expect(await page.evaluate(() => "injected" in window)).toBe(false);
});
