import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { finalizeEvent, generateSecretKey, type Event } from "nostr-tools/pure";
import { matchFilter } from "nostr-tools/filter";
import { nprofileEncode } from "nostr-tools/nip19";
test.use({ serviceWorkers: "block", reducedMotion: "reduce" });
const enabled = process.env.VITE_ENABLE_PROFILES === "true";
const discussions = process.env.VITE_ENABLE_DISCUSSIONS === "true";
const key = generateSecretKey(), other = generateSecretKey();
const make = (content: string, tags: string[][] = [], created_at = 1700000000, kind = 1) => finalizeEvent({ content, tags, created_at, kind }, key);
const focus = make("Original promoted note");
const child = make("An unpaid reply", [["e", focus.id, "", "root"]], 1700000100);
const nested = make("Keep this branch open", [["e", focus.id, "", "root"], ["e", child.id, "", "reply"]], 1700000200);
const waiting = make("Author promotion in waiting room");
const foreign = finalizeEvent({ kind: 1, created_at: 1700000000, content: "Someone else mentioned the author", tags: [["p", focus.pubkey]] }, other);
const profile = make(JSON.stringify({ name: "fixture", display_name: "Profile author", about: "Public author bio", website: "https://example.com/author", nip05: "claimed@example.com" }), [], 1700000000, 0);
const fresh = make(JSON.stringify({ name: "fixture", display_name: "Updated author", about: "New outbox metadata", nip05: "claimed@example.com" }), [], 1700000100, 0);
const list = make("", [["r", "wss://outbox.example.com", "write"], ["r", "wss://inbox.example.com", "read"]], 1700000000, 10002);
interface Options { block?: boolean; empty?: boolean; outbox?: boolean; metadata?: Event; failWaiting?: boolean }
async function setup(context: BrowserContext, page: Page, options: Options = {}) {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const requests: { relay: string; filter: Record<string, unknown> }[] = [];
    const closed = new Set<string>(), blocked = new Set<string>(), publications: string[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const entry = (event: Event, rank: number) => ({ id: event.id, event, rank, weight: 200, sats_paid: 210, first_paid_at: 1700000000, last_paid_at: 1700000000 });
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.origin !== "http://127.0.0.1:3334") return route.abort();
        if (url.pathname.includes("waiting-updates")) return route.fulfill({ json: { count: 0, note_ids: [], checked_at: Date.now() } });
        if (url.pathname.includes("campaigns") && url.searchParams.get("view") === "top") {
            if (options.failWaiting) return route.fulfill({ status: 503, body: "unavailable" });
            return route.fulfill({ json: { entries: [entry(waiting, 22)], targets: [], total: 1, active_posts: 22, has_more: false } });
        }
        return route.fulfill({ json: { entries: [entry(focus, 1), entry(foreign, 2)], targets: [], total: 22, active_posts: 22, has_more: false, posts: 22, total_sats: 420 } });
    });
    await context.routeWebSocket("**/*", socket => {
        if (socket.url().startsWith(origin.replace(/^http/, "ws"))) return socket.connectToServer();
        socket.onMessage(message => {
            const msg = JSON.parse(String(message));
            if (msg[0] === "CLOSE") { closed.add(msg[1]); return; }
            if (msg[0] !== "REQ") { publications.push(msg[0]); return; }
            for (const filter of msg.slice(2)) requests.push({ relay: socket.url(), filter });
            const events = [focus, child, nested, waiting, list];
            if (!options.empty) events.push(options.metadata ?? (options.outbox && socket.url().includes("outbox.example.com") ? fresh : profile));
            for (const event of events) if (msg.slice(2).some((filter: Parameters<typeof matchFilter>[0]) => matchFilter(filter, event))) socket.send(JSON.stringify(["EVENT", msg[1], event]));
            if (options.block && msg.slice(2).some((filter: { kinds?: number[] }) => filter.kinds?.includes(0))) { blocked.add(msg[1]); return; }
            socket.send(JSON.stringify(["EOSE", msg[1]]));
        });
    });
    return { requests, closed, blocked, publications, errors };
}
const url = `/profile/${focus.pubkey}`;
const coverage = (page: Page) => page.getByRole("region", { name: "Profile coverage", exact: true });
async function settled(page: Page) { await expect(coverage(page)).toHaveAttribute("data-read-state", /^(settled|partial)$/, { timeout: 16000 }); }

test("profiles remain external and dedicated routes disabled by default", async ({ context, page }) => {
    test.skip(enabled);
    await setup(context, page); await page.goto("/");
    const author = page.locator("article").first().getByRole("link", { name: "Profile author", exact: true });
    await expect(author).toHaveAttribute("href", /^https:\/\/njump.me\/nprofile/);
    await expect(author).toHaveAttribute("target", "_blank");
    await page.goto(url); await expect(page.getByRole("region", { name: "Author profile" })).toHaveCount(0);
    await page.goto(`/profile/${nprofileEncode({ pubkey: focus.pubkey })}`); await expect(page.getByRole("region", { name: "Author profile" })).toHaveCount(0);
});
test.describe("read-only profiles", () => {
    test.skip(!enabled);
    test("reads author outboxes and joins only the author's active campaigns", async ({ context, page }) => {
        const fixture = await setup(context, page, { outbox: true });
        await page.goto(url); await settled(page);
        await expect(page.getByRole("heading", { name: "Updated author", exact: true })).toBeVisible();
        await expect(page.getByText("Claimed address (unverified): claimed@example.com")).toBeVisible();
        const notes = page.getByRole("region", { name: "Active promoted notes", exact: true });
        await expect(notes).toContainText(waiting.content);
        await expect(notes).toContainText(focus.content);
        await expect(notes).not.toContainText(foreign.content);
        await expect(notes.locator("article")).toHaveCount(2);
        expect(fixture.requests.some(request => request.relay.includes("outbox.example.com") && (request.filter.kinds as number[])?.includes(0))).toBe(true);
        expect(fixture.requests.some(request => request.relay.includes("inbox.example.com"))).toBe(false);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: `/private/tmp/holoboard-profile-${test.info().project.name}.png`, fullPage: true });
        await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
        await page.getByRole("button", { name: "Copy npub", exact: true }).click();
        await expect(page.getByText("Clipboard is unavailable. Select the public key above to copy it.", { exact: true })).toBeVisible();
        expect(fixture.publications).toEqual([]); expect(fixture.errors).toEqual([]);
    });
    test("retains metadata on timeout and allows an explicit retry", async ({ context, page }) => {
        const options: Options = { block: true }; await setup(context, page, options);
        await page.goto(url); await settled(page);
        await expect(coverage(page)).toHaveAttribute("data-read-state", "partial");
        await expect(page.getByRole("heading", { name: "Profile author", exact: true })).toBeVisible();
        await expect(coverage(page)).toContainText("Some sources could not be checked");
        options.block = false; await page.getByRole("button", { name: "Refresh profile" }).click();
        await expect(coverage(page)).toHaveAttribute("data-read-state", "settled");
    });
    test("distinguishes checked absence from an unreadable signed profile", async ({ context, page }) => {
        const options: Options = { empty: true }; await setup(context, page, options);
        await page.goto(url); await settled(page);
        await expect(coverage(page)).toContainText("No profile found on checked sources");
        options.empty = false; options.metadata = make("null", [], 1700000200, 0);
        await page.getByRole("button", { name: "Refresh profile" }).click(); await settled(page);
        await expect(coverage(page)).toContainText("unreadable metadata");
    });
    test("keeps malformed fields and markup inert", async ({ context, page }) => {
        const metadata = make(JSON.stringify({ name: "Safe author", about: '<script>window.profileXss=1</script>', website: "javascript:alert(1)", picture: "data:text/html,unsafe", nip05: "claim@example.com" }), [], 1700000200, 0);
        await setup(context, page, { metadata }); await page.goto(url); await settled(page);
        const region = page.getByRole("region", { name: "Author profile" });
        await expect(region).toContainText("<script>window.profileXss=1</script>");
        await expect(region.locator('a[href^="javascript:"], img[src^="data:"]')).toHaveCount(0);
        expect(await page.evaluate(() => "profileXss" in window)).toBe(false);
    });
    test("retains promotions and retries the same unavailable waiting page", async ({ context, page }) => {
        const options: Options = { failWaiting: true }; await setup(context, page, options);
        await page.goto(url);
        const region = page.getByRole("region", { name: "Active promoted notes", exact: true });
        await expect(region).toContainText(focus.content);
        await expect(region.getByRole("alert")).toBeVisible();
        options.failWaiting = false; await region.getByRole("button", { name: "Retry promotions" }).click();
        await expect(region).toContainText(waiting.content);
        await expect(region.locator("article")).toHaveCount(2);
    });
    test("closes pending profile reads when leaving the screen", async ({ context, page }) => {
        const fixture = await setup(context, page, { block: true }); await page.goto(url);
        await expect.poll(() => fixture.blocked.size).toBeGreaterThan(0);
        const owned = [...fixture.blocked];
        await page.getByRole("link", { name: "Back to board" }).click();
        await expect.poll(() => owned.every(id => fixture.closed.has(id))).toBe(true);
        await expect(coverage(page)).toHaveCount(0); expect(fixture.errors).toEqual([]);
    });
    test("closes note popovers when browser history hides the retained board", async ({ context, page }) => {
        const fixture = await setup(context, page);
        await page.goto("/");
        const source = page.locator("[data-board-note]").first();
        await source.getByRole("link", { name: "Profile author", exact: true }).click();
        await expect(page.getByRole("region", { name: "Author profile", exact: true })).toBeVisible();
        for (const kind of ["weight", "options"] as const) {
            await page.goBack();
            await expect(source).toBeVisible();
            await source.locator(kind === "weight" ? ".board-weight" : ".board-options").click();
            const popup = page.getByRole(kind === "weight" ? "dialog" : "menu", { name: kind === "weight" ? "Ranking weight" : "Note options", exact: true });
            await expect(popup).toBeVisible();
            await page.goForward();
            await expect(page.getByRole("region", { name: "Author profile", exact: true })).toBeVisible();
            await expect(popup).toHaveCount(0);
        }
        expect(fixture.publications).toEqual([]);
        expect(fixture.errors).toEqual([]);
    });
    test("returns to the same discussion branch and reading position", async ({ context, page }) => {
        test.skip(!discussions);
        await setup(context, page); await page.goto(`/discussion/${focus.id}?from=%2Fwaiting%3Fview%3Dhot`);
        const row = page.locator(`[data-discussion-key="event:${child.id}"]`);
        await expect(page.getByText(nested.content, { exact: true })).toBeVisible();
        await row.getByRole("button", { name: "Hide replies" }).click();
        await expect(page.getByText(nested.content, { exact: true })).toHaveCount(0);
        await expect(page.getByRole("region", { name: "Discussion coverage" })).toHaveAttribute("data-read-state", /^(paused|settled)$/);
        const byline = page.getByRole("article", { name: "Discussion focus" }).getByRole("link", { name: "Profile author", exact: true });
        await byline.scrollIntoViewIfNeeded();
        const before = await page.evaluate(() => window.scrollY);
        await byline.click(); await expect(page.getByRole("region", { name: "Author profile" })).toBeVisible();
        await page.getByRole("link", { name: "Back to discussion" }).click();
        await expect(page.getByText(nested.content, { exact: true })).toHaveCount(0);
        await expect.poll(() => page.evaluate(position => Math.abs(window.scrollY - position), before)).toBeLessThan(3);
        await row.getByRole("button", { name: "Show replies (1)" }).click();
        await expect(page.getByText(nested.content, { exact: true })).toBeVisible();
        await byline.click();
        const notes = page.getByRole("region", { name: "Active promoted notes", exact: true });
        await notes.getByRole("link", { name: "Discussion", exact: true }).first().click();
        await page.getByRole("link", { name: "Back to profile" }).click();
        await expect(page.getByRole("region", { name: "Author profile" })).toBeVisible();
        await page.goBack(); await expect(page.getByRole("region", { name: "Discussion coverage" })).toBeVisible();
    });
});
