import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { finalizeEvent, generateSecretKey, type Event } from "nostr-tools/pure";
import { noteEncode } from "nostr-tools/nip19";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });
const key = generateSecretKey();
const note = (content: string) => finalizeEvent({ kind: 1, created_at: 1700000000, content, tags: [] }, key);
const visitKey = "holoboard-waiting-visit:http://127.0.0.1:3334/api/board";
const profile = finalizeEvent({ kind: 0, created_at: 1700000000, content: JSON.stringify({ name: "Test author" }), tags: [] }, key);

async function mockBoard(context: BrowserContext, page: Page, content = "A note in the waiting room.") {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const originals = Array.from({ length: 25 }, (_, index) => note(index === 0 ? content : `Other waiting note ${index}`));
    const state = { checkpoint: 2000000, notes: originals, updates: [] as string[], failedCampaigns: false, failedUpdates: false, previewFails: false, brokenImage: false, billboard: false, previewRequests: [] as string[], queries: [] as string[], quotedNotes: [] as Event[] };
    await context.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.origin !== "http://127.0.0.1:3334") return route.abort();
        const headers = { "Access-Control-Allow-Origin": "*" };
        if (url.pathname === "/image.png") return route.fulfill({ status: 404, headers, body: "Image unavailable" });
        if (url.pathname === "/api/link-preview") {
            state.previewRequests.push(url.searchParams.get("url")!);
            return route.fulfill({ status: state.previewFails ? 502 : 200, headers, contentType: "application/json", body: JSON.stringify({
                url: "https://example.com/article", title: "A page <script>title</script>", description: "A useful summary.", ...(state.brokenImage ? { image_url: "http://127.0.0.1:3334/image.png" } : {}),
            }) });
        }
        if (url.pathname === "/api/board/waiting-updates") {
            state.queries.push(url.search);
            const since = url.searchParams.get("since");
            const ids = since && Number(since) < state.checkpoint ? state.updates : [];
            return route.fulfill({ status: state.failedUpdates ? 503 : 200, headers, contentType: "application/json", body: JSON.stringify({ count: ids.length, note_ids: ids, checked_at: state.checkpoint }) });
        }
        const waiting = url.searchParams.get("view") !== "board";
        const first = ((Number(url.searchParams.get("page")) || 1) - 1) * 21;
        const notes = waiting ? state.notes.slice(first, first + 21) : state.notes.slice(0, 1);
        return route.fulfill({ status: state.failedCampaigns ? 503 : 200, headers, contentType: "application/json", body: JSON.stringify({
            entries: notes.map((event, index) => ({ event, id: event.id, rank: waiting ? first + index + 22 : 1, weight: 200, sats_paid: 210, first_paid_at: 1000, hot_sats: 21, author_share: 0, ...(state.billboard ? { billboard: { template: "poster", text: "A billboard", color: "cyan", size: "medium", speed: "normal" } } : {}) })),
            targets: [], total: waiting ? state.notes.length : 1, active_posts: 21 + state.notes.length, has_more: waiting && first + 21 < state.notes.length, checked_at: state.checkpoint,
        }) });
    });
    await context.routeWebSocket("**/*", socket => {
        if (socket.url().startsWith(origin.replace(/^http/, "ws"))) return socket.connectToServer();
        socket.onMessage(message => {
            const msg = JSON.parse(String(message));
            if (msg[0] !== "REQ") return;
            if (msg.slice(2).some((filter: { kinds?: number[] }) => filter.kinds?.includes(0))) socket.send(JSON.stringify(["EVENT", msg[1], profile]));
            for (const event of state.quotedNotes) if (msg.slice(2).some((filter: { ids?: string[] }) => filter.ids?.includes(event.id))) socket.send(JSON.stringify(["EVENT", msg[1], event]));
            socket.send(JSON.stringify(["EOSE", msg[1]]));
        });
    });
    return state;
}

async function resumePage(page: Page) {
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

test("waiting-room badge counts all new notes and keeps marks throughout the visit", async ({ context, page }) => {
    const state = await mockBoard(context, page);
    await page.goto("/");
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), visitKey)).toBe("2000000");
    await expect(page.getByLabel(/new notes since your last visit/)).toHaveCount(0);
    state.checkpoint = 2001000;
    state.updates = state.notes.map(event => event.id);
    await resumePage(page);
    await expect(page.getByLabel("25 new notes since your last visit", { exact: true })).toBeVisible();
    await page.getByRole("navigation", { name: "Board sections" }).getByRole("link", { name: /^Waiting room/ }).click();
    await expect(page.getByRole("status").filter({ hasText: "25 new notes since your last visit." })).toBeVisible();
    await expect(page.getByLabel("New since your last visit", { exact: true })).toHaveCount(21);
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), visitKey)).toBe("2001000");
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    await expect(page.getByLabel("New since your last visit", { exact: true })).toHaveCount(25);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await expect(page.getByLabel("New since your last visit", { exact: true })).toHaveCount(21);
    await page.getByRole("button", { name: "Hot", exact: true }).click();
    await expect(page.getByLabel("25 new notes since your last visit", { exact: true })).toBeVisible();
    await page.getByRole("navigation", { name: "Board sections" }).getByRole("link", { name: "TOP 21", exact: true }).click();
    await page.waitForURL("**/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("link", { name: "TOP 21", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("article").first()).toBeVisible();
    await expect(page.getByLabel(/new notes since your last visit/)).toHaveCount(0);
    await expect.poll(() => state.queries.at(-1)).toBe("?since=2001000");
});

test("failed campaign and update requests do not acknowledge a waiting-room visit", async ({ context, page }) => {
    const state = await mockBoard(context, page);
    await context.addInitScript(key => localStorage.setItem(key, "2000000"), visitKey);
    state.checkpoint = 2001000; state.updates = [state.notes[0].id]; state.failedCampaigns = true;
    await page.goto("/waiting");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByLabel("1 new note since your last visit", { exact: true })).toBeVisible();
    expect(await page.evaluate(key => localStorage.getItem(key), visitKey)).toBe("2000000");
    state.failedCampaigns = false; state.failedUpdates = true;
    await page.reload();
    await expect(page.getByRole("article").first()).toBeVisible();
    expect(await page.evaluate(key => localStorage.getItem(key), visitKey)).toBe("2000000");
    state.failedUpdates = false;
    await resumePage(page);
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), visitKey)).toBe("2001000");
});

test("blocked storage keeps a checkpoint while navigating within a waiting-room visit", async ({ context, page }) => {
    await context.addInitScript(() => Object.defineProperty(window, "localStorage", { get: () => { throw new DOMException("Storage blocked", "SecurityError"); } }));
    const state = await mockBoard(context, page);
    await page.goto("/waiting");
    await expect(page.getByRole("article").first()).toBeVisible();
    // Wait for the in-memory baseline to reach an outgoing check, not just request start.
    await expect.poll(async () => { await resumePage(page); return state.queries.at(-1); }).toBe("?since=2000000");
    state.checkpoint = 2001000; state.updates = [state.notes[0].id];
    await resumePage(page);
    await expect(page.getByLabel("New since your last visit", { exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await expect(page.getByLabel("New since your last visit", { exact: true })).toHaveCount(1);
});

test("the first ordinary link gets a safe card with text retained after image failure", async ({ context, page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    const reference = noteEncode(note("Quoted note").id);
    const state = await mockBoard(context, page, `https://example.com/a.png nostr:${reference} https://example.com/article. https://example.com/second`);
    state.brokenImage = true;
    await page.goto("/");
    const row = page.getByRole("article").first();
    const more = row.getByRole("button", { name: /Show more/ });
    if (await more.isVisible()) await more.click();
    const card = row.getByRole("link", { name: "Open link: A page <script>title</script>", exact: true });
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("href", "https://example.com/article");
    await expect(card).toContainText("A useful summary.");
    await expect(card.locator("img")).toHaveCount(0);
    expect(await row.locator("script").count()).toBe(0);
    expect(state.previewRequests).toEqual(["https://example.com/article"]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const top = page.getByRole("link", { name: "TOP 21", exact: true });
    await expect(top).toHaveText("TOP 21");
    expect(await page.locator("footer a").first().evaluate(el => getComputedStyle(el).fontFamily)).toContain("PressStart2P");
});

test("failed metadata keeps the original link usable", async ({ context, page }) => {
    const state = await mockBoard(context, page, "Read https://example.com/article"); state.previewFails = true;
    await page.goto("/");
    await expect.poll(() => state.previewRequests.length).toBe(1);
    await expect(page.getByRole("article").first().getByRole("link", { name: "https://example.com/article", exact: true })).toHaveAttribute("href", "https://example.com/article");
    await expect(page.locator(".note-link-preview")).toHaveCount(0);
});

test("expanding a long note exposes its complete link card", async ({ context, page }) => {
    const state = await mockBoard(context, page, `${"A longer original paragraph. ".repeat(80)}\nhttps://example.com/article`);
    await page.goto("/");
    const row = page.getByRole("article").first();
    const expand = row.getByRole("button", { name: /Show more/ });
    await expect(expand).toBeVisible();
    await expand.click();
    await row.getByRole("link", { name: "https://example.com/article", exact: true }).scrollIntoViewIfNeeded();
    await expect(row.locator(".note-link-preview")).toBeVisible();
    expect(state.previewRequests).toEqual(["https://example.com/article"]);
});

test("billboard links show one preview before and after opening original text", async ({ context, page }) => {
    const state = await mockBoard(context, page, "Visit https://example.com/article"); state.billboard = true;
    await page.goto("/");
    const row = page.getByRole("article").first();
    await expect(row.locator(".note-link-preview")).toHaveCount(1);
    await expect(row.locator(".note-link-preview")).toBeVisible();
    await row.getByRole("button", { name: /Show original/ }).click();
    await expect(row.getByText("Original text", { exact: true })).toBeVisible();
    await expect(row.locator(".note-link-preview")).toHaveCount(1);
    expect(state.previewRequests).toEqual(["https://example.com/article"]);
});

test("quoted notes can preview their first ordinary link", async ({ context, page }) => {
    const quoted = note("Quoted context https://example.com/article");
    const state = await mockBoard(context, page, `Source nostr:${noteEncode(quoted.id)}`); state.quotedNotes = [quoted];
    await page.goto("/");
    const quote = page.getByLabel("Quoted note", { exact: true });
    await expect(quote.getByRole("link", { name: "Open link: A page <script>title</script>", exact: true })).toBeVisible();
    await expect(quote.getByRole("link", { name: "Open quoted note", exact: true })).toBeVisible();
    expect(state.previewRequests).toEqual(["https://example.com/article"]);
});
