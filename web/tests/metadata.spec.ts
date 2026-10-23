import { test, expect } from "@playwright/test";
import { boardMetadata, waitingMetadata, helpMetadata, expiredMetadata } from "../src/lib/pageMetadata";

test.use({ serviceWorkers: "block" });

const publicKey = "1".repeat(64);
const pages = [
    { path: "/", ...boardMetadata },
    { path: "/waiting?view=new", ...waitingMetadata },
    { path: "/help#ranking", ...helpMetadata },
    { path: "/expired", ...expiredMetadata },
    { path: `/profile/${publicKey}?from=%2Fwaiting`, title: "Profile | Holoboard", description: "Read this author's profile and explore their active posts on Holoboard." },
    { path: `/discussion/${publicKey}`, title: "Discussion | Holoboard", description: "Read the conversation around a post on Holoboard, explore replies and open the original post." },
];

test.describe("metadata before JavaScript", () => {
    test.use({ javaScriptEnabled: false });
    for (const entry of pages) test(`serves ${entry.title} without running the app`, async ({ page }) => {
        const response = await page.goto(entry.path);
        expect(response?.status()).toBe(200);
        await expect(page).toHaveURL(new URL(entry.path, test.info().project.use.baseURL!).href);
        await expect(page).toHaveTitle(entry.title);
        for (const selector of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) {
            await expect(page.locator(selector)).toHaveAttribute("content", entry.description);
        }
        await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", entry.title);
        await expect(page.locator('meta[name="twitter:title"]')).toHaveAttribute("content", entry.title);
        await expect(page.locator("noscript div[data-nosnippet]")).toContainText("Enable JavaScript");
        await expect(page.locator("body")).not.toContainText("renders a live Nostr relay feed");
        if (entry.path.startsWith("/profile/") || entry.path.startsWith("/discussion/")) {
            await expect(page.locator('meta[property="og:url"]')).toHaveCount(0);
        }
    });
});

test("section metadata follows navigation, direct loads and browser history", async ({ context, page }) => {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.origin !== "http://127.0.0.1:3334") return route.abort();
        return route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, json: {
            entries: [], targets: [], total: 0, active_posts: 0, has_more: false,
            checked_at: Date.now(), count: 0, note_ids: [], next_cursor: null,
        } });
    });
    await context.routeWebSocket("**/*", socket => {
        if (socket.url().startsWith(origin.replace(/^http/, "ws"))) return socket.connectToServer();
        socket.onMessage(raw => {
            const message = JSON.parse(String(raw));
            if (message[0] === "REQ") socket.send(JSON.stringify(["EOSE", message[1]]));
        });
    });
    const check = async (metadata: typeof boardMetadata) => {
        await expect(page).toHaveTitle(metadata.title);
        await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", metadata.description);
        await expect(page.locator('meta[property="og:description"]')).toHaveAttribute("content", metadata.description);
        await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", origin + new URL(page.url()).pathname);
    };
    await page.goto("/waiting?view=new");
    await check(waitingMetadata);
    await page.getByRole("link", { name: "Help", exact: true }).click();
    await check(helpMetadata);
    await page.getByRole("link", { name: "< Back to board", exact: true }).click();
    await check(boardMetadata);
    await page.getByRole("navigation", { name: "Board sections" }).getByRole("link", { name: /^Waiting room/ }).click();
    await check(waitingMetadata);
    await page.getByRole("link", { name: "Expired notes", exact: true }).click();
    await check(expiredMetadata);
    await page.goBack();
    await check(waitingMetadata);
    await page.goForward();
    await check(expiredMetadata);
    await page.reload();
    await check(expiredMetadata);
});
