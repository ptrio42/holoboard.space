import { test, expect, type BrowserContext } from "@playwright/test";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });
const key = generateSecretKey();
const created = Math.floor(Date.now() / 1000) - 3600;
const original = finalizeEvent({ kind: 1, created_at: created - 3600, content: "A practical account of restoring a local community garden.", tags: [] }, key);
const profile = finalizeEvent({ kind: 0, created_at: created, content: JSON.stringify({ name: "Garden author" }), tags: [] }, key);

async function discoveryBackend(context: BrowserContext, status = "pending", reason = "An original practical account from a less visible community project.") {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const promotions: Record<string, unknown>[] = [];
    const entry = { entry_type: "discovery", id: original.id, event: original, first_visible_at: created,
        discovery: { reason, topic: "community", language: "en", expires_at: created + 604800, reward_sats: 100, reward_status: status } };
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.origin !== "http://127.0.0.1:3334") return route.abort();
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (url.pathname === "/api/board/waiting-updates") return route.fulfill({ headers, json: { count: 0, note_ids: [], checked_at: Date.now() } });
        if (url.pathname === "/api/board/campaigns") {
            const mixed = url.searchParams.get("view") === "new" && url.searchParams.get("include_discoveries") === "true";
            return route.fulfill({ headers, json: { entries: mixed ? [entry] : [], targets: [], total: mixed ? 1 : 0, active_posts: 0,
                total_sats: 0, has_more: false, waiting_posts: 1, checked_at: Date.now() } });
        }
        if (url.pathname === "/api/board") return route.fulfill({ headers, json: { entries: [], posts: 0, total_sats: 0, updated_at: created } });
        if (url.pathname === "/api/promote/preview") return route.fulfill({ headers, json: { event: original, active: false,
            rank: 0, weight: 0, sats_paid: 0, author_share: 0, billboard_fee_sats: 100, images: [] } });
        if (url.pathname === "/api/support") return route.fulfill({ headers, json: { available: false, reason_code: "no_address", reason: "The author has no Lightning address.", min_sats: 0, max_sats: 0, allows_nostr: false } });
        if (url.pathname === "/api/promote") {
            const body = route.request().postDataJSON() as Record<string, unknown>;
            promotions.push(body);
            return route.fulfill({ headers, json: { invoice: "lnbc-discovery-visibility", payment_hash: "ab".repeat(32), amount_sats: body.amount_sats,
                promotion_sats: body.amount_sats, note_id: original.id, expires_at: Math.floor(Date.now() / 1000) + 3600, billboard_fee_sats: 0 } });
        }
        if (url.pathname === "/api/promote/status") return route.fulfill({ headers, json: { pending: true, settled: false, sats_paid: 0 } });
        return route.fulfill({ headers, status: 404, json: { error: "Not available in this fixture" } });
    });
    await context.routeWebSocket("**/*", socket => {
        if (socket.url().startsWith(origin.replace(/^http/, "ws"))) return socket.connectToServer();
        socket.onMessage(message => {
            const request = JSON.parse(String(message));
            if (request[0] !== "REQ") return;
            for (const event of [profile, original]) {
                if (request.slice(2).some((filter: { ids?: string[]; kinds?: number[]; authors?: string[] }) =>
                    (!filter.ids || filter.ids.includes(event.id)) && (!filter.kinds || filter.kinds.includes(event.kind)) &&
                    (!filter.authors || filter.authors.includes(event.pubkey)))) socket.send(JSON.stringify(["EVENT", request[1], event]));
            }
            socket.send(JSON.stringify(["EOSE", request[1]]));
        });
    });
    return { promotions };
}

test("New shows an unranked discovery with a pending reward and ordinary promotion", async ({ context, page }) => {
    const state = await discoveryBackend(context);
    await page.goto("/waiting?view=new");
    const row = page.locator(`[data-board-note="${original.id}"]`);
    await expect(row.getByText("Discovered by Holoboard", { exact: true })).toBeVisible();
    await expect(row.getByText(original.content, { exact: true })).toBeVisible();
    await expect(row.getByText("Author reward: 100 sats pending", { exact: true })).toBeVisible();
    await expect(row.locator(".board-rank, .board-weight")).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Promote", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("discovery.png"), fullPage: true });
    await row.getByRole("button", { name: "Promote", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByText(original.content, { exact: true })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: /^Continue to payment · \d+ sats$/ }).click();
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", "lightning:lnbc-discovery-visibility");
    await expect(page.getByRole("button", { name: "Copy invoice", exact: true })).toBeVisible();
    expect(state.promotions).toHaveLength(1);
    expect(state.promotions[0].note).toBe(original.id);
    expect(state.promotions[0].zap_request).toBeUndefined();
});

test("discovery-only waiting room remains reachable below an empty TOP 21", async ({ context, page }) => {
    await discoveryBackend(context, "unavailable");
    await page.goto("/");
    const link = page.getByRole("link", { name: "Waiting room (1)", exact: true });
    await expect(link).toBeVisible();
    await link.click();
    await page.getByRole("link", { name: "See New", exact: true }).click();
    await expect(page.getByText("Author reward unavailable", { exact: true })).toBeVisible();
    await expect(page.locator(".board-rank, .board-weight")).toHaveCount(0);
});

test("an unbroken discovery reason wraps inside a narrow phone card", async ({ context, page }) => {
    const reason = "x".repeat(280);
    await page.setViewportSize({ width: 320, height: 640 });
    await discoveryBackend(context, "pending", reason);
    await page.goto("/waiting?view=new");
    const details = page.getByLabel("Holoboard discovery", { exact: true });
    const explanation = details.getByText(reason, { exact: true });
    await expect(explanation).toBeVisible();
    expect(await explanation.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("paid and uncertain rewards have distinct labels without becoming paid visibility", async ({ context, page }) => {
    await discoveryBackend(context, "uncertain");
    await page.goto("/waiting?view=new");
    await expect(page.getByText("Author reward: 100 sats, confirmation pending", { exact: true })).toBeVisible();
    await expect(page.locator(".board-weight")).toHaveCount(0);
});

test("discussion handoff preserves discovery presentation", async ({ context, page }) => {
    test.skip(process.env.VITE_ENABLE_DISCUSSIONS !== "true", "Requires read-only discussion feature");
    await discoveryBackend(context, "paid");
    await page.goto("/waiting?view=new");
    await page.locator(`[data-board-note="${original.id}"]`).getByRole("link", { name: "Discussion", exact: true }).click();
    const focus = page.locator(`[data-reading-focus="${original.id}"]`);
    await expect(focus.getByText("Discovered by Holoboard", { exact: true })).toBeVisible();
    await expect(focus.getByText("Author reward: 100 sats paid", { exact: true })).toBeVisible();
    await expect(focus.locator(".board-rank, .board-weight")).toHaveCount(0);
});
