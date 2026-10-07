import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { finalizeEvent, generateSecretKey, type Event } from "nostr-tools/pure";
import { neventEncode, noteEncode } from "nostr-tools/nip19";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });
const authorKey = generateSecretKey(), quoteKey = generateSecretKey();
const makeNote = (content: string, tags: string[][] = [], key = authorKey, kind = 1) =>
    finalizeEvent({ kind, created_at: 1700000000, content, tags }, key);
const quotes = Array.from({ length: 6 }, (_, i) => makeNote(`Quoted source ${i + 1}. ` + "Context for the original note. ".repeat(12), [], quoteKey));
const profiles = [makeNote(JSON.stringify({ name: "Row author" }), [], authorKey, 0), makeNote(JSON.stringify({ name: "Quote author" }), [], quoteKey, 0)];

async function setup(context: BrowserContext, page: Page, options: { content?: string; billboard?: boolean; tags?: string[][]; availableQuotes?: Event[]; expired?: boolean; slowQuote?: { deliver?: () => void; fastReplies: number } } = {}) {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const note = makeNote(options.content ?? "A billboard headline.\n" + quotes.map(quote => `nostr:${noteEncode(quote.id)}`).join("\n"), options.tags);
    const entry = { event: note, id: note.id, rank: 1, weight: 200, sats_paid: 210, first_paid_at: 1700000000, last_paid_at: 1700000000,
        hot_sats: 21, author_share: 20, ...(options.billboard !== false ? { billboard: { template: "poster", color: "cyan", size: "medium", speed: "normal", text: "A billboard headline." } } : {}) };
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

test("billboard controls share a footer and reveal complete quotes and original text", async ({ context, page }) => {
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
    const disclosure = row.getByRole("button", { name: /Show original/ });
    const external = row.getByRole("link", { name: "Open note", exact: true });
    await expect(external).toHaveAttribute("href", /^https:\/\/njump.me\/note1/);
    await expect(row.locator(".note-footer").getByRole("button", { name: /Show original/ })).toBeVisible();
    await expect(row.locator(".note-footer").getByRole("button", { name: "Boost", exact: true })).toBeVisible();
    await expect.poll(() => row.locator(".note-quote[inert]").count()).toBeGreaterThan(0);
    const firstQuote = row.locator(".note-quote").first();
    expect(await firstQuote.evaluate(element => {
        const viewport = element.closest("[id]")!;
        return element.getBoundingClientRect().bottom <= viewport.getBoundingClientRect().bottom + 1;
    })).toBe(true);
    for (const control of [disclosure, external, row.getByRole("button", { name: "Boost", exact: true }), firstQuote.getByRole("link", { name: "Open quoted note" })]) {
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await disclosure.focus();
    await page.keyboard.press("Enter");
    await expect(row.getByText("Original text", { exact: true })).toBeVisible();
    await expect(row.locator(".note-quote[inert]")).toHaveCount(0);
    await expect(row.getByRole("link", { name: "Open quoted note" })).toHaveCount(6);
    await row.locator(".note-quote").last().scrollIntoViewIfNeeded();
    await expect(row.locator(".note-quote").last()).toContainText("Quoted source 6");
    await row.getByRole("button", { name: /Hide original/ }).click();
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

test("unavailable quotes retain an accessible external link", async ({ context, page }) => {
    const row = await setup(context, page, { content: `A billboard headline.\nnostr:${noteEncode(quotes[0].id)}`, availableQuotes: [] });
    await expect(row.getByText("Loading preview", { exact: false })).toBeVisible();
    await expect(row.getByText("Preview unavailable", { exact: true })).toBeVisible({ timeout: 10000 });
    const link = row.getByRole("link", { name: "Open quoted note" });
    await expect(link).toHaveAttribute("href", /^https:\/\/njump.me\/nevent1/);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveText("Open");
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

test("short replies keep conversation context near the author", async ({ context, page }) => {
    const row = await setup(context, page, { billboard: false, content: "A short reply.", tags: [["e", quotes[0].id, "", "reply"]] });
    const contextLink = row.getByRole("link", { name: /In reply to/ });
    await expect(contextLink).toHaveAttribute("href", `https://njump.me/${noteEncode(quotes[0].id)}`);
    await expect(row.locator(".note-footer").getByRole("link", { name: /In reply to/ })).toHaveCount(0);
    await expect(row.getByRole("button", { name: /Show more|Show original/ })).toHaveCount(0);
    expect((await contextLink.boundingBox())!.y).toBeLessThan((await row.getByText("A short reply.", { exact: true }).boundingBox())!.y);
});

test("expired notes retain their historical payment and promotion action", async ({ context, page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    const row = await setup(context, page, { expired: true, billboard: false, content: "An expired paragraph.\n".repeat(24) });
    await expect(page.getByRole("heading", { name: "HOLOBOARD", exact: true })).toBeVisible();
    const sections = page.getByRole("navigation", { name: "Board sections" });
    await expect(sections.getByRole("link", { name: "Expired", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(sections.getByRole("link", { name: "TOP 21" })).toHaveAttribute("href", "/");
    await expect(sections.getByRole("link", { name: "Waiting room" })).toHaveAttribute("href", "/waiting");
    await expect(page.getByRole("navigation", { name: "Connections and help" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Promote a note", exact: true })).toBeVisible();
    await expect(page.locator("footer").getByRole("link", { name: "How ranking works" })).toBeVisible();
    await expect(row.getByText(/Last payment:/)).toBeVisible();
    await expect(row.getByRole("button", { name: "Promote again", exact: true })).toBeVisible();
    await expect(row.getByRole("link", { name: "Open note", exact: true })).toBeVisible();
    await row.getByRole("button", { name: /Show more/ }).click();
    await expect(row.getByRole("button", { name: /Show less/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
