import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { matchFilter } from "nostr-tools/filter";
import { decode } from "nostr-tools/nip19";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });
const signerEnabled = process.env.VITE_ENABLE_NOSTR_CONNECT === "true";
const profilesEnabled = process.env.VITE_ENABLE_PROFILES === "true";
const authorKey = generateSecretKey(), accountKey = generateSecretKey();
const accountPubkey = getPublicKey(accountKey);
const note = finalizeEvent({ kind: 1, created_at: 1700000000, tags: [], content: "An open board for ideas worth discovering. Support a note to give it more visibility." }, authorKey);

async function setup(context: BrowserContext, page: Page, name = "starlight", brokenPicture = false) {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const metadata = finalizeEvent({ kind: 0, created_at: 1700000000, tags: [], content: JSON.stringify({ name, picture: `${origin}/fixture-avatar.svg` }) }, accountKey);
    const author = finalizeEvent({ kind: 0, created_at: 1700000000, tags: [], content: JSON.stringify({ name: "board explorer" }) }, authorKey);
    const state = { publicFrames: [] as string[], writes: [] as string[], errors: [] as string[] };
    page.on("pageerror", error => state.errors.push(error.message));
    await context.addInitScript(pubkey => {
        Object.assign(window, { nostr: { getPublicKey: async () => pubkey, signEvent: async () => { throw new Error("This header check must not sign events."); } } });
    }, accountPubkey);
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname === "/fixture-avatar.svg") return route.fulfill({ status: brokenPicture ? 404 : 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path fill="#143346" d="M0 0h32v32H0z"/><path fill="#67e8f9" d="M8 6h18v4H12v4h14v12H6v-4h16v-4H8z"/></svg>' });
        if (url.origin === origin) return route.continue();
        if (url.origin !== "http://127.0.0.1:3334") return route.abort();
        if (route.request().method() !== "GET") state.writes.push(url.pathname);
        return route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, json: url.pathname.includes("waiting-updates")
            ? { count: 0, note_ids: [], checked_at: Date.now() }
            : { entries: [{ id: note.id, event: note, rank: 1, weight: 1200, sats_paid: 1800 }], targets: [], total: 1, active_posts: 1, has_more: false, total_sats: 1800 } });
    });
    await context.routeWebSocket("**/*", socket => {
        if (socket.url().startsWith(origin.replace(/^http/, "ws"))) return socket.connectToServer();
        socket.onMessage(message => {
            const frame = JSON.parse(String(message));
            if (frame[0] === "CLOSE") return;
            if (frame[0] !== "REQ") { state.publicFrames.push(frame[0]); return; }
            for (const event of [note, metadata, author]) if (frame.slice(2).some((filter: Parameters<typeof matchFilter>[0]) => matchFilter(filter, event))) socket.send(JSON.stringify(["EVENT", frame[1], event]));
            socket.send(JSON.stringify(["EOSE", frame[1]]));
        });
    });
    await page.goto("/");
    await expect(page.getByRole("article").first()).toContainText(note.content);
    await page.evaluate(() => document.fonts.ready);
    return state;
}

async function checkHeader(page: Page) {
    // Mobile WebKit applies responsive styles asynchronously after a resize.
    await expect(async () => {
        const viewportWidth = await page.evaluate(() => innerWidth);
        const boxes = await page.locator("header").first().locator('h1 a, button[aria-label="Promote a note"], .header-tool').evaluateAll(nodes => nodes.map(node => {
            const { x, y, width, height, right } = node.getBoundingClientRect(); return { x, y, width, height, right };
        }));
        expect(boxes.every(box => box.width >= 44 && box.height >= 44 && box.x >= 0 && box.right <= viewportWidth)).toBe(true);
        expect(Math.max(...boxes.map(box => box.y)) - Math.min(...boxes.map(box => box.y))).toBeLessThan(4);
        for (let i = 1; i < boxes.length; i++) expect(boxes[i].x, JSON.stringify({ viewportWidth, boxes })).toBeGreaterThanOrEqual(boxes[i - 1].right);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }).toPass({ timeout: 3000 });
}

test("header keeps promotion primary and wallet available without signing in", async ({ context, page }, testInfo) => {
    const state = await setup(context, page);
    await checkHeader(page);
    const connections = page.getByRole("navigation", { name: "Connections", exact: true });
    await expect(connections.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(signerEnabled ? 1 : 0);
    await page.locator("header").first().screenshot({ path: testInfo.outputPath("header-signed-out.png") });
    const wallet = connections.getByRole("button", { name: "Wallet", exact: true });
    await wallet.click();
    await expect(page.getByRole("dialog", { name: "Connect wallet", exact: true })).toContainText("Invoice / QR payments also work without connecting.");
    await page.keyboard.press("Escape");
    await expect(wallet).toBeFocused();
    for (const width of [768, 320]) { await page.setViewportSize({ width, height: 800 }); await checkHeader(page); }
    await page.locator("header").first().screenshot({ path: testInfo.outputPath("header-320px.png") });
    expect(state.writes).toEqual([]); expect(state.publicFrames).toEqual([]); expect(state.errors).toEqual([]);
});

test("sign in presents account methods without payment copy and explains missing extensions", async ({ context, page }, testInfo) => {
    test.skip(!signerEnabled);
    const state = await setup(context, page);
    await page.evaluate(() => Reflect.deleteProperty(window, "nostr"));
    const trigger = page.getByRole("navigation", { name: "Connections", exact: true }).getByRole("button", { name: "Sign in", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Sign in", exact: true });
    const extension = dialog.getByRole("button", { name: "Browser extension", exact: true });
    const remote = dialog.getByRole("button", { name: "Amber / remote signer", exact: true });
    await expect(extension).toBeDisabled();
    await expect(extension).toHaveAccessibleDescription("No Nostr extension detected in this browser.");
    await expect(remote).toBeEnabled();
    await expect(dialog).not.toContainText(/optional|zap|invoice|wallet/i);
    await expect(dialog.getByLabel("Bunker connection link")).toBeHidden();
    for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        for (const button of [extension, remote]) expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
        await page.screenshot({ path: testInfo.outputPath(`sign-in-${width}.png`) });
    }
    await dialog.getByText("Use a bunker link", { exact: true }).click();
    await expect(dialog.getByLabel("Bunker connection link")).toBeVisible();
    await expect(dialog.getByLabel("Bunker connection link")).toHaveAttribute("type", "password");
    await page.screenshot({ path: testInfo.outputPath("sign-in-bunker-320.png") });
    await page.setViewportSize({ width: 320, height: 640 });
    await remote.click();
    await expect(dialog.getByRole("link", { name: "Open Amber / signer", exact: true })).toBeVisible();
    await expect(dialog.getByRole("status")).toContainText("Waiting for approval");
    await expect(dialog.getByText("Approve the connection in your signer, then return here.", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("sign-in-amber-320.png") });
    await dialog.getByText("Show QR", { exact: true }).click();
    const qr = dialog.getByRole("img", { name: "Signer connection QR code", exact: true });
    await expect(qr).toBeVisible();
    const cancel = dialog.getByRole("button", { name: "Cancel sign in", exact: true });
    expect((await cancel.boundingBox())!.y).toBeLessThan((await qr.boundingBox())!.y);
    await qr.scrollIntoViewIfNeeded();
    await expect(qr).toBeInViewport({ ratio: 1 });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("sign-in-amber-qr-320.png") });
    await cancel.click();
    await expect(remote).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(state.writes).toEqual([]); expect(state.publicFrames).toEqual([]); expect(state.errors).toEqual([]);
});

for (const longName of [false, true]) test(`account menu preserves focus and optional profile navigation (${longName ? "long name and missing picture" : "profile"})`, async ({ context, page }, testInfo) => {
    test.skip(!signerEnabled);
    const name = longName ? "starlight with a very long public display name" : "starlight";
    const state = await setup(context, page, name, longName);
    const connections = page.getByRole("navigation", { name: "Connections", exact: true });
    await connections.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("dialog", { name: "Sign in", exact: true }).getByRole("button", { name: "Browser extension", exact: true }).click();
    await expect(page.getByText("Connected extension:", { exact: false })).toBeVisible();
    const account = connections.getByRole("button", { name: `Account: ${name}`, exact: true });
    await expect(account).toBeAttached();
    await page.keyboard.press("Escape");
    await expect(account).toBeFocused();
    await checkHeader(page);
    await page.locator("header").first().screenshot({ path: testInfo.outputPath("header-connected.png") });
    await account.click();
    const menu = page.getByRole("menu", { name: "Account", exact: true });
    await expect(menu.getByRole("menuitem", { name: "Your profile", exact: true })).toHaveCount(profilesEnabled ? 1 : 0);
    await page.screenshot({ path: testInfo.outputPath("account-menu.png") });
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem", { name: "Disconnect", exact: true })).toBeFocused();
    await page.keyboard.press("Escape"); await expect(account).toBeFocused();
    await account.click();
    await menu.getByRole("menuitem", { name: "Connection settings", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Nostr account", exact: true })).toBeVisible();
    await page.keyboard.press("Escape"); await expect(account).toBeFocused();
    if (profilesEnabled) {
        await account.click(); await menu.getByRole("menuitem", { name: "Your profile", exact: true }).click();
        await expect(page).toHaveURL(/\/profile\/nprofile1/);
        const pointer = decode(new URL(page.url()).pathname.split("/").at(-1)!);
        expect(pointer.type).toBe("nprofile");
        if (pointer.type !== "nprofile") throw new Error("Expected an nprofile route");
        expect(pointer.data.pubkey).toBe(accountPubkey);
        await expect(menu).toHaveCount(0);
        await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
        await page.goBack(); await expect(page).toHaveURL(/\/$/);
    }
    for (const width of [768, 320]) { await page.setViewportSize({ width, height: 800 }); await checkHeader(page); }
    await page.locator("header").first().screenshot({ path: testInfo.outputPath("header-connected-320px.png") });
    await account.click();
    const narrowMenu = page.getByRole("menu", { name: "Account", exact: true });
    await expect(narrowMenu).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("account-menu-320px.png") });
    await narrowMenu.getByRole("menuitem", { name: "Disconnect", exact: true }).click();
    await expect(connections.getByRole("button", { name: "Sign in", exact: true })).toBeFocused();
    await expect(narrowMenu).toHaveCount(0);
    expect(state.writes).toEqual([]); expect(state.publicFrames).toEqual([]); expect(state.errors).toEqual([]);
});
