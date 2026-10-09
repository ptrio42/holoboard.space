import { test, expect, type BrowserContext, type Page, type Route } from "@playwright/test";
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
interface Options { selected?: Event; events?: Event[]; block?: boolean; empty?: boolean; outbox?: boolean; metadata?: Event; failWaiting?: boolean; nip05?: "match" | "mismatch" | "unavailable" | "redirect" | "pending" }
async function setup(context: BrowserContext, page: Page, options: Options = {}) {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const requests: { relay: string; filter: Record<string, unknown> }[] = [];
    const closed = new Set<string>(), blocked = new Set<string>(), publications: string[] = [], errors: string[] = [];
    const previewNotes: string[] = [];
    const addressRequests: string[] = [], pendingAddresses: Route[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const entry = (event: Event, rank: number) => ({ id: event.id, event, rank, weight: 200, sats_paid: 210, first_paid_at: 1700000000, last_paid_at: 1700000000 });
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.origin === "https://example.com" && url.pathname === "/.well-known/nostr.json") {
            addressRequests.push(url.href);
            if (options.nip05 === "pending") { pendingAddresses.push(route); return; }
            if (options.nip05 === "unavailable") return route.abort();
            if (options.nip05 === "redirect") return route.fulfill({ status: 302, headers: { location: "https://other.example.com/.well-known/nostr.json" }, body: "redirect" });
            return route.fulfill({ json: { names: { [url.searchParams.get("name")!]: options.nip05 === "mismatch" ? foreign.pubkey : focus.pubkey } } });
        }
        if (url.hostname === "images.example.com") return url.pathname.includes("broken") ? route.abort() : route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="800" height="300" fill="#164e63"/></svg>' });
        if (url.origin !== "http://127.0.0.1:3334") return route.abort();
        if (url.pathname === "/api/promote/preview") {
            const selected = options.selected ?? focus;
            previewNotes.push(route.request().postDataJSON().note);
            return route.fulfill({ json: { event: selected, active: true, sats_paid: 210, weight: 200, rank: 1, billboard_fee_sats: 100, images: [], author_share: 20 } });
        }
        if (url.pathname.includes("waiting-updates")) return route.fulfill({ json: { count: 0, note_ids: [], checked_at: Date.now() } });
        if (url.pathname.includes("campaigns") && url.searchParams.get("view") === "top") {
            if (options.failWaiting) return route.fulfill({ status: 503, body: "unavailable" });
            return route.fulfill({ json: { entries: [entry(waiting, 22)], targets: [], total: 1, active_posts: 22, has_more: false } });
        }
        return route.fulfill({ json: { entries: [entry(options.selected ?? focus, 1), entry(foreign, 2)], targets: [], total: 22, active_posts: 22, has_more: false, posts: 22, total_sats: 420 } });
    });
    await context.routeWebSocket("**/*", socket => {
        if (socket.url().startsWith(origin.replace(/^http/, "ws"))) return socket.connectToServer();
        socket.onMessage(message => {
            const msg = JSON.parse(String(message));
            if (msg[0] === "CLOSE") { closed.add(msg[1]); return; }
            if (msg[0] !== "REQ") { publications.push(msg[0]); return; }
            for (const filter of msg.slice(2)) requests.push({ relay: socket.url(), filter });
            const events = [options.selected ?? focus, child, nested, waiting, list, ...(options.events ?? [])];
            if (!options.empty) events.push(options.metadata ?? (options.outbox && socket.url().includes("outbox.example.com") ? fresh : profile));
            for (const event of events) if (msg.slice(2).some((filter: Parameters<typeof matchFilter>[0]) => matchFilter(filter, event))) socket.send(JSON.stringify(["EVENT", msg[1], event]));
            if (options.block && msg.slice(2).some((filter: { kinds?: number[] }) => filter.kinds?.includes(0))) { blocked.add(msg[1]); return; }
            socket.send(JSON.stringify(["EOSE", msg[1]]));
        });
    });
    return { requests, closed, blocked, publications, errors, addressRequests, pendingAddresses, previewNotes };
}
const url = `/profile/${focus.pubkey}`;
const coverage = (page: Page) => page.getByRole("region", { name: "Profile coverage", exact: true });
async function settled(page: Page) { await expect(coverage(page)).toHaveAttribute("data-read-state", /^(settled|partial)$/, { timeout: 16000 }); }
async function refreshProfile(page: Page) {
    const refresh = page.getByRole("button", { name: "Refresh profile", exact: true });
    if (!await refresh.isVisible()) await page.getByText("Profile details", { exact: true }).click();
    await refresh.click();
}

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
    test("shows adaptive profile cards with quotes and accurate promotion controls", async ({ context, page }, testInfo) => {
        const quoted = make("Quoted original context");
        const selected = make("Short profile note with a quote", [["q", quoted.id]]);
        const fixture = await setup(context, page, { selected, events: [quoted] });
        await page.goto(url); await settled(page);
        const card = page.locator(`[data-profile-note="${selected.id}"]`);
        await expect(card).toContainText(quoted.content);
        for (const width of [320, 390, 1280]) {
            await page.setViewportSize({ width, height: 900 });
            await expect(card.locator(".board-rank")).toHaveAttribute("aria-label", "Rank 1");
            await expect(card.getByRole("button", { name: "Boost", exact: true })).toBeVisible();
            await expect(card.getByRole("button", { name: "Note options", exact: true })).toBeVisible();
            await card.getByRole("button", { name: /counting,.*paid in total/ }).click();
            await expect(page.getByRole("dialog", { name: "Ranking weight" })).toContainText("210 sats");
            await page.keyboard.press("Escape");
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await card.screenshot({ path: testInfo.outputPath(`profile-card-${width}.png`) });
        }
        await card.getByRole("button", { name: "Boost", exact: true }).click();
        const boost = page.getByRole("dialog", { name: "Boost note", exact: true });
        await expect(boost).toBeVisible();
        await expect(boost).toContainText(selected.content);
        expect(fixture.previewNotes).toEqual([selected.id]);
        await page.keyboard.press("Escape");
        await expect(boost).toHaveCount(0);
        if (discussions) {
            await card.getByRole("link", { name: "Discussion", exact: true }).click();
            await expect(page.getByRole("article", { name: "Discussion focus", exact: true })).toContainText(selected.content);
            await page.getByRole("link", { name: "Back to profile", exact: true }).click();
            await expect(card).toBeVisible();
        }
        expect(fixture.publications).toEqual([]); expect(fixture.errors).toEqual([]);
    });
    test("keeps identity beside notes on desktop and readable on narrow phones", async ({ context, page }) => {
        const metadata = make(JSON.stringify({ name: "fixture", display_name: "A longer profile author name", about: "A public biography with enough text to wrap on a phone.", banner: "https://images.example.com/banner.png", picture: "https://images.example.com/avatar.png", nip05: "claimed@example.com", lud16: "author@pay.example.com" }), [], 1700000200, 0);
        const fixture = await setup(context, page, { metadata });
        await page.goto(url); await settled(page);
        await expect(page.locator('[data-nip05-state="verified"]')).toBeVisible();
        const identity = page.getByRole("region", { name: "Author profile", exact: true });
        await expect(identity.getByRole("img", { name: "Profile banner", exact: true })).toBeVisible();
        await expect(identity.getByRole("region", { name: "Lightning address" })).toContainText("author@pay.example.com");
        for (const width of [320, 390, 1280]) {
            await page.setViewportSize({ width, height: 900 });
            await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            const author = await identity.boundingBox();
            const notes = await page.getByRole("region", { name: "Active promoted notes", exact: true }).boundingBox();
            expect(author).not.toBeNull(); expect(notes).not.toBeNull();
            if (width >= 768) { expect(notes!.x).toBeGreaterThan(author!.x + author!.width); expect(Math.abs(notes!.y - author!.y)).toBeLessThan(2); }
            else expect(notes!.y).toBeGreaterThan(author!.y + author!.height);
            await page.screenshot({ path: test.info().outputPath(`profile-identity-${width}.png`), fullPage: true });
        }
        await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { sessionStorage.setItem("test-copied-address", value); } } }));
        await identity.getByRole("button", { name: "Copy Lightning address", exact: true }).click();
        await expect(identity.getByText("Lightning address copied.", { exact: true })).toBeVisible();
        expect(await page.evaluate(() => sessionStorage.getItem("test-copied-address"))).toBe("author@pay.example.com");
        await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
        await identity.getByRole("button", { name: "Copy Lightning address", exact: true }).click();
        await expect(identity.getByText("Clipboard unavailable. Select the address to copy it.", { exact: true })).toBeVisible();
        expect(fixture.publications).toEqual([]); expect(fixture.errors).toEqual([]);
    });
    for (const outcome of ["mismatch", "unavailable", "redirect"] as const) test(`keeps NIP-05 ${outcome} distinct from verified metadata`, async ({ context, page, browserName }) => {
        test.skip(outcome === "redirect" && browserName === "webkit", "Playwright WebKit cannot fulfill intercepted requests with redirect statuses; unit and Chromium checks cover redirects.");
        const options: Options = { nip05: outcome }; const fixture = await setup(context, page, options);
        await page.goto(url); await settled(page);
        await expect(page.getByRole("heading", { name: "Profile author", exact: true })).toBeVisible();
        await expect(page.locator(".profile-nip05")).toHaveAttribute("data-nip05-state", outcome === "mismatch" ? "mismatch" : "unavailable");
        await expect(page.getByRole("img", { name: "NIP-05 address matches this public key", exact: true })).toHaveCount(0);
        if (outcome !== "mismatch") {
            options.nip05 = "match"; await page.getByRole("button", { name: "Retry address check" }).click();
            await expect(page.locator('[data-nip05-state="verified"]')).toBeVisible();
        }
        expect(fixture.publications).toEqual([]); expect(fixture.errors).toEqual([]);
    });
    test("does not apply an older NIP-05 check to a changed address", async ({ context, page }) => {
        const options: Options = { nip05: "pending" }; const fixture = await setup(context, page, options);
        await page.goto(url); await settled(page);
        await expect.poll(() => fixture.pendingAddresses.length).toBeGreaterThan(0);
        await expect(page.locator('[data-nip05-state="checking"]')).toBeVisible();
        options.metadata = make(JSON.stringify({ name: "fixture", display_name: "Profile author", nip05: "new@example.com" }), [], 1700000300, 0);
        await refreshProfile(page);
        await expect(page.locator(".profile-nip05-address")).toHaveText("new@example.com");
        await expect.poll(() => fixture.pendingAddresses.some(route => new URL(route.request().url()).searchParams.get("name") === "new")).toBe(true);
        for (const route of fixture.pendingAddresses.filter(route => new URL(route.request().url()).searchParams.get("name") === "claimed")) await route.fulfill({ json: { names: { claimed: focus.pubkey } } }).catch(() => {});
        await expect(page.locator('[data-nip05-state="checking"]')).toBeVisible();
        const current = fixture.pendingAddresses.find(route => new URL(route.request().url()).searchParams.get("name") === "new")!;
        await current.fulfill({ json: { names: { new: foreign.pubkey } } });
        await expect(page.locator('[data-nip05-state="mismatch"]')).toBeVisible();
        expect(fixture.errors).toEqual([]);
    });
    test("collapses broken banners and keeps absent profile fields compact", async ({ context, page }) => {
        const metadata = make(JSON.stringify({ name: "fixture", display_name: "Profile author", banner: "https://images.example.com/broken.png" }), [], 1700000200, 0);
        await setup(context, page, { metadata }); await page.goto(url); await settled(page);
        await expect(page.locator(".profile-banner")).toHaveCount(0);
        await expect(page.locator(".profile-identity")).not.toHaveClass(/has-banner/);
        await expect(page.getByRole("region", { name: "Lightning address" })).toHaveCount(0);
        await expect(page.locator(".profile-nip05")).toHaveCount(0);
        await expect(page.getByRole("heading", { name: "Profile author", exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
    test("reads author outboxes and joins only the author's active campaigns", async ({ context, page }) => {
        const fixture = await setup(context, page, { outbox: true });
        await page.goto(url); await settled(page);
        await expect(page.getByRole("heading", { name: "Updated author", exact: true })).toBeVisible();
        await expect(page.locator('[data-nip05-state="verified"]')).toContainText("claimed@example.com");
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
        await expect(page.getByText("Clipboard is unavailable. Select the public key below to copy it.", { exact: true })).toBeVisible();
        await expect(page.getByLabel("Nostr public key", { exact: true })).toBeVisible();
        await expect(page.getByLabel("Nostr public key", { exact: true })).toBeFocused();
        expect(fixture.publications).toEqual([]); expect(fixture.errors).toEqual([]);
    });
    test("retains metadata on timeout and allows an explicit retry", async ({ context, page }) => {
        const options: Options = { block: true }; await setup(context, page, options);
        await page.goto(url); await settled(page);
        await expect(coverage(page)).toHaveAttribute("data-read-state", "partial");
        await expect(page.getByRole("heading", { name: "Profile author", exact: true })).toBeVisible();
        await expect(coverage(page)).toContainText("Some sources could not be checked");
        options.block = false; await refreshProfile(page);
        await expect(coverage(page)).toHaveAttribute("data-read-state", "settled");
    });
    test("distinguishes checked absence from an unreadable signed profile", async ({ context, page }) => {
        const options: Options = { empty: true }; await setup(context, page, options);
        await page.goto(url); await settled(page);
        await expect(coverage(page)).toContainText("No profile found on checked sources");
        options.empty = false; options.metadata = make("null", [], 1700000200, 0);
        await refreshProfile(page); await settled(page);
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
