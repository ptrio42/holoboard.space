import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { finalizeEvent, generateSecretKey, type Event } from "nostr-tools/pure";
import { matchFilter } from "nostr-tools/filter";

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
interface Options { focus?: Event; events?: Event[]; slowParent?: Event; blockReplies?: boolean; many?: number }
async function setup(context: BrowserContext, page: Page, options: Options = {}) {
    const selected = options.focus ?? focus;
    const extra = Array.from({ length: options.many ?? 0 }, (_, i) => make(`Sibling ${String(i + 1).padStart(2, "0")}`, [["e", selected.id, "", "reply"]], 1700000500 + i));
    const events = [selected, root, child, paid, promo, wrong, mention, profile, relayList, ...(options.events ?? []), ...extra].filter(event => event.id !== options.slowParent?.id);
    const entry = (event: Event, rank: number) => ({ id: event.id, event, rank, weight: 200, sats_paid: 210, first_paid_at: 1700000000, last_paid_at: 1700000000 });
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const closes = new Set<string>(), blocked = new Set<string>(), publications: unknown[] = [];
    let deliver: (() => void) | undefined;
    let missingAvailable = false;
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.origin !== "http://127.0.0.1:3334") return route.abort();
        const data = url.pathname.includes("waiting-updates") ? { count: 0, note_ids: [], checked_at: Date.now() } :
            { entries: [entry(selected, 1), entry(paid, 25)], targets: [], total: 2, active_posts: 2, has_more: false, posts: 2, total_sats: 420 };
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
    return { selected, publications, closes, blocked, deliver: () => deliver?.(), hasDelivery: () => !!deliver };
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
});

test.describe("read-only discussion", () => {
    test.skip(!enabled);
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
        await expect(row(page, child).getByText("Promoted", { exact: true })).toHaveCount(0);
        await expect(row(page, paid)).toContainText(paid.content);
        await expect(row(page, paid).getByRole("link", { name: /Go to parent note by/ })).toContainText(child.content);
        await row(page, paid).getByRole("link", { name: /Go to parent note by/ }).click();
        await expect(row(page, child)).toBeFocused();
        await expect(row(page, paid).getByRole("link", { name: "Open thread", exact: true })).toBeVisible();
        await expect(page.getByText(/Reply level|Focus here/)).toHaveCount(0);
        await expect(row(page, paid).getByText("Promoted", { exact: true })).toBeVisible();
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
    test("bounds rendered replies and exposes the rest through local pages", async ({ context, page }) => {
        const selected = make("Many replies focus");
        await setup(context, page, { focus: selected, many: 55 });
        await page.goto(`/discussion/${selected.id}`);
        await expect(page.getByRole("heading", { name: "55 found replies" })).toBeVisible();
        const replies = page.getByRole("region", { name: "Replies", exact: true });
        await expect(replies.locator("article")).toHaveCount(48);
        await page.evaluate(() => document.fonts.ready);
        const first = replies.locator("article").first();
        expect((await first.boundingBox())!.height).toBeLessThan(185);
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
