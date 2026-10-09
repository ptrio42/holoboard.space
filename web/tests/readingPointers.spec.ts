import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { matchFilter } from "nostr-tools/filter";
import { decode, neventEncode, nprofileEncode } from "nostr-tools/nip19";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });
const enabled = process.env.VITE_ENABLE_DISCUSSIONS === "true" && process.env.VITE_ENABLE_PROFILES === "true";
const key = generateSecretKey(), hint = "wss://pointer.example.com/public";
const note = finalizeEvent({ kind: 1, created_at: 1700000000, tags: [], content: "Found exclusively through the event pointer" }, key);
const reply = finalizeEvent({ kind: 1, created_at: 1700000010, tags: [["e", note.id, "", "reply"]], content: "Reply on the hinted relay" }, key);
const metadata = finalizeEvent({ kind: 0, created_at: 1700000000, tags: [], content: JSON.stringify({ name: "Pointer author", about: "Found exclusively through the profile pointer" }) }, key);
const list = finalizeEvent({ kind: 10002, created_at: 1700000000, tags: [["r", hint, "write"], ["r", "wss://receive.example.com/inbox", "read"]], content: "" }, key);

async function setup(context: BrowserContext, page: Page) {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const requests: { relay: string; filter: Parameters<typeof matchFilter>[0] }[] = [];
    const publications: string[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/*", route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        return route.fulfill({ json: { entries: [], targets: [], total: 0, active_posts: 0, has_more: false, posts: 0, total_sats: 0, count: 0, note_ids: [], checked_at: Date.now() } });
    });
    await context.routeWebSocket("**/*", socket => {
        if (socket.url().startsWith(origin.replace(/^http/, "ws"))) return socket.connectToServer();
        socket.onMessage(message => {
            const msg = JSON.parse(String(message));
            if (msg[0] === "CLOSE") return;
            if (msg[0] !== "REQ") { publications.push(msg[0]); return; }
            for (const filter of msg.slice(2)) requests.push({ relay: socket.url(), filter });
            // Configured and discovery relays have none of these events.
            if (socket.url() === hint) for (const event of [note, reply, metadata, list]) {
                if (msg.slice(2).some((filter: Parameters<typeof matchFilter>[0]) => matchFilter(filter, event))) socket.send(JSON.stringify(["EVENT", msg[1], event]));
            }
            socket.send(JSON.stringify(["EOSE", msg[1]]));
        });
    });
    return { requests, publications, errors };
}

test.describe("NIP-19 reading pointers", () => {
    test.skip(!enabled);
    test("loads a hint-only discussion, shares observed sources and restores navigation", async ({ context, page }) => {
        const fixture = await setup(context, page);
        const pointer = neventEncode({ id: note.id, author: "f".repeat(64), relays: [hint, "wss://127.0.0.1", "ws://unsafe.example.com"] });
        const path = `/discussion/${pointer}`;
        await page.goto(path);
        await expect(page.getByText(note.content, { exact: true })).toBeVisible({ timeout: 20000 });
        const child = page.locator(`[data-discussion-key="event:${reply.id}"]`);
        await expect(child).toContainText(reply.content);
        const thread = child.getByRole("link", { name: "Open thread", exact: true });
        const shared = decode(new URL((await thread.getAttribute("href"))!, "https://holoboard.invalid").pathname.split("/")[2]);
        expect(shared).toMatchObject({ type: "nevent", data: { id: reply.id, author: note.pubkey, relays: [hint] } });
        const focusByline = page.getByRole("article", { name: "Discussion focus", exact: true }).getByRole("link", { name: "Pointer author", exact: true });
        await expect(focusByline).toBeVisible();
        const focusProfilePointer = decode(new URL((await focusByline.getAttribute("href"))!, "https://holoboard.invalid").pathname.split("/")[2]);
        expect(focusProfilePointer).toMatchObject({ type: "nprofile", data: { pubkey: note.pubkey, relays: [hint] } });
        const byline = child.getByRole("link", { name: "Pointer author", exact: true });
        await expect(byline).toHaveAttribute("href", /^\/profile\/nprofile1/);
        const profilePointer = decode(new URL((await byline.getAttribute("href"))!, "https://holoboard.invalid").pathname.split("/")[2]);
        expect(profilePointer).toMatchObject({ type: "nprofile", data: { pubkey: note.pubkey, relays: [hint] } });
        await byline.click();
        await expect(page.getByRole("region", { name: "Author profile" })).toContainText("Found exclusively through the profile pointer");
        await page.getByRole("link", { name: "Back to discussion" }).click();
        await expect(page).toHaveURL(new RegExp(`${pointer}$`));
        await expect(child).toContainText(reply.content);
        expect(fixture.requests.some(request => request.relay === hint && request.filter.ids?.includes(note.id))).toBe(true);
        expect(fixture.requests.some(request => request.relay.includes("unsafe.example.com") || request.relay.includes("wss://127.0.0.1"))).toBe(false);
        expect(fixture.publications).toEqual([]); expect(fixture.errors).toEqual([]);
    });
    test("opens a cold nprofile directly using only its safe embedded relay", async ({ context, page }) => {
        const fixture = await setup(context, page);
        await page.goto(`/profile/${nprofileEncode({ pubkey: note.pubkey, relays: [hint, "wss://relay.local"] })}`);
        await expect(page.getByRole("heading", { name: "Pointer author", exact: true })).toBeVisible();
        await expect(page.getByRole("region", { name: "Author profile" })).toContainText("Found exclusively through the profile pointer");
        expect(fixture.requests.some(request => request.relay === hint && request.filter.kinds?.includes(0))).toBe(true);
        expect(fixture.requests.some(request => request.relay.includes("relay.local") || request.relay.includes("receive.example.com"))).toBe(false);
        expect(fixture.publications).toEqual([]); expect(fixture.errors).toEqual([]);
    });
});
