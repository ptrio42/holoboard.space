import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import { neventEncode, noteEncode } from "nostr-tools/nip19";
import { matchFilter } from "nostr-tools/filter";
import { walletInvoice } from "./helpers/walletFixture";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });
test.skip(process.env.VITE_ENABLE_POST_CREATION !== "true", "Requires the independent creation release gate");
const original = finalizeEvent({ kind: 1, created_at: 1700000000, tags: [], content: "Original source for a quote." }, generateSecretKey());
const accountKey = generateSecretKey(), accountPubkey = getPublicKey(accountKey);
const boardHash = "b".repeat(64);

async function completeAccountPopup(popup: Page) {
    const completed = popup.waitForEvent("close", { timeout: 20000 });
    await popup.getByRole("button", { name: "Complete verified sign-in" }).click();
    await completed;
}

async function setup(context: BrowserContext, page: Page) {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const state = { requests: [] as Record<string, unknown>[], signed: undefined as Event | undefined, paid: false, frames: [] as string[], errors: [] as string[], links: [] as string[], tokenRequests: 0, revoked: false, challenge: "", wrongState: false, pauseBoard: false, releaseBoard: undefined as (() => void) | undefined };
    page.on("pageerror", error => state.errors.push(error.message));
    await context.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (url.origin === "http://127.0.0.1:3100") {
            if (url.pathname === "/api/oauth/authorize") {
                state.challenge = url.searchParams.get("code_challenge")!;
                expect(url.searchParams.get("scope")).toBe("policy:holoboard");
                const destination = new URL(url.searchParams.get("redirect_uri")!);
                destination.searchParams.set("state", state.wrongState ? "wrong-state" : url.searchParams.get("state")!); destination.searchParams.set("code", "fixture-code");
                return route.fulfill({ contentType: "text/html", body: `<html><body><h1>Email account fixture</h1><button onclick='location.href=${JSON.stringify(destination.href)}'>Complete verified sign-in</button></body></html>` });
            }
            if (url.pathname === "/api/oauth/token") {
                state.tokenRequests++;
                const body = route.request().postDataJSON();
                expect(body.code).toBe("fixture-code");
                expect(createHash("sha256").update(body.code_verifier).digest("base64url")).toBe(state.challenge);
                return route.fulfill({ headers, json: { access_token: "fixture-token", bunker_url: `bunker://${"a".repeat(64)}?relay=wss://example.invalid`, expires_in: 3600 } });
            }
            if (url.pathname === "/api/nostr") {
                const body = route.request().postDataJSON();
                expect(route.request().headers().authorization).toBe("Bearer fixture-token");
                return route.fulfill({ headers, json: { result: body.method === "get_public_key" ? accountPubkey : finalizeEvent(body.params[0], accountKey) } });
            }
            if (url.pathname === "/holoboard-session.html") return route.fulfill({ contentType: "text/html", body: readFileSync(new URL("../../accounts/holoboard-session.html", import.meta.url), "utf8").replace('const allowedOrigins = ["http://127.0.0.1:4173"];', `const allowedOrigins = ${JSON.stringify([origin])};`) });
            if (url.pathname === "/api/user/sessions/revoke") { state.revoked = true; expect(route.request().postDataJSON().bunker_pubkey).toBe("a".repeat(64)); return route.fulfill({ headers, json: { success: true } }); }
            if (url.pathname === "/api/auth/logout") return route.fulfill({ headers, json: { success: true } });
        }
        if (url.origin !== "http://127.0.0.1:3334") return route.abort();
        const body = route.request().method() === "POST" ? route.request().postDataJSON() : {};
        let data: unknown = {};
        if (url.pathname === "/api/board/campaigns") data = { entries: [{ id: original.id, event: original, rank: 1, sats_paid: 100, weight: 100 }], targets: [], total: 1, active_posts: 1, has_more: false, total_sats: 100 };
        else if (url.pathname === "/api/board/waiting-updates") data = { count: 0, note_ids: [], checked_at: Date.now() };
        else if (url.pathname === "/api/promote/preview") {
            const event = body.event ?? (body.note === state.signed?.id ? state.signed : original);
            if (body.event) { expect(verifyEvent(body.event)).toBe(true); state.signed = body.event; }
            data = { event, active: state.paid && event.id === state.signed?.id, sats_paid: state.paid && event.id === state.signed?.id ? 210 : 0, weight: 0, rank: 0, author_share: 0, billboard_fee_sats: 100, images: [] };
        } else if (url.pathname === "/api/support") data = { available: false, author: body.event?.pubkey ?? original.pubkey, reason_code: "no_address", reason: "No payment address", min_sats: 1, max_sats: 0, allows_nostr: false };
        else if (url.pathname === "/api/promote") {
            state.requests.push(body);
            if (state.pauseBoard) await new Promise<void>(resolve => { state.releaseBoard = resolve; });
            data = { invoice: walletInvoice({ hash: boardHash, amountMsats: body.amount_sats * 1000 }), payment_hash: boardHash, amount_sats: body.amount_sats, promotion_sats: body.amount_sats, note_id: body.event?.id ?? original.id, expires_at: Math.floor(Date.now() / 1000) + 3600, billboard_fee_sats: 0 };
        } else if (url.pathname === "/api/promote/status") data = { pending: !state.paid, settled: state.paid, publication: state.paid ? "pending" : undefined, receipt: state.paid ? { promotion_sats: 210 } : undefined };
        else if (url.pathname === "/api/link-preview") { state.links.push(url.searchParams.get("url")!); data = { url: url.searchParams.get("url"), title: "An ordinary page", description: "Link preview" }; }
        return route.fulfill({ headers, json: data });
    });
    await context.routeWebSocket("**/*", socket => {
        if (socket.url().startsWith(origin.replace(/^http/, "ws"))) return socket.connectToServer();
        socket.onMessage(raw => {
            const frame = JSON.parse(String(raw));
            if (frame[0] === "CLOSE") return;
            if (frame[0] !== "REQ") { state.frames.push(frame[0]); return; }
            if (frame.slice(2).some((filter: Parameters<typeof matchFilter>[0]) => matchFilter(filter, original))) socket.send(JSON.stringify(["EVENT", frame[1], original]));
            socket.send(JSON.stringify(["EOSE", frame[1]]));
        });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Add to board", exact: true }).click();
    return state;
}

test("guest text and links become one private signed post with recoverable invoices", async ({ context, page }, info) => {
    const state = await setup(context, page);
    const dialog = page.getByRole("dialog", { name: "Add to board", exact: true });
    const text = "A new post about https://example.com/story and https://example.com/other";
    await dialog.getByRole("textbox", { name: "Text or link" }).fill(text);
    await expect(dialog.locator(".note-link-preview")).toHaveCount(1);
    await dialog.getByRole("button", { name: "Review post", exact: true }).click();
    await expect(dialog.getByText("Ready for payment.", { exact: false })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Add to board 210 sats", exact: true })).toBeEnabled();
    await dialog.getByRole("tab", { name: "Billboard", exact: true }).click();
    await expect(dialog.getByRole("article")).toHaveCount(1);
    await expect(dialog.getByRole("link", { name: "Discussion", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Note options", exact: true })).toHaveCount(0);
    await dialog.getByRole("tab", { name: "Promotion", exact: true }).click();
    await dialog.getByRole("button", { name: "Save author key", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Copy private author key" })).toBeVisible();
    for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 850 });
        await expect(dialog.getByRole("button", { name: "Add to board 210 sats", exact: true })).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`guest-${width}.png`) });
    }
    await dialog.getByRole("button", { name: "Add to board 210 sats", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Promotion payment" })).toBeVisible();
    expect(state.requests).toHaveLength(1);
    const submitted = state.requests[0].event as Event;
    expect(verifyEvent(submitted)).toBe(true); expect(submitted.content).toBe(text);
    expect(state.requests[0].author_share).toBe(0);
    expect(state.frames).toEqual([]);
    const persisted = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(sessionStorage))));
    expect(persisted).not.toContain("nsec1");
    await page.reload();
    await page.getByRole("button", { name: "Add to board", exact: true }).click();
    await expect(page.getByText("Unfinished payments", { exact: true })).toBeVisible();
    await page.getByText("Unfinished payments", { exact: true }).click();
    await page.getByRole("button", { name: /Resume/ }).first().click();
    await expect(page.getByRole("dialog", { name: "Promotion payment" })).toBeVisible();
    expect(state.requests).toHaveLength(1);
    state.paid = true;
    await expect(page.getByLabel("Promotion result")).toContainText("Delivery to other apps is pending");
    expect(state.signed?.id).toBe(submitted.id); expect(state.errors).toEqual([]);
});

test("original and quote interpretation remain explicit and have separate paid IDs", async ({ context, page }) => {
    const state = await setup(context, page);
    const field = page.getByRole("textbox", { name: "Text or link" });
    await field.fill(original.id);
    await expect(page.getByText("Original post", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add a comment" }).click();
    await field.fill(`My comment nostr:${neventEncode({ id: original.id })}`);
    await field.fill(`nostr:${neventEncode({ id: original.id })}`);
    await expect(page.getByText("Your post", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Review post", exact: true }).click();
    await expect(page.getByRole("button", { name: "Add to board 210 sats", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Add to board 210 sats", exact: true }).click();
    expect(state.requests).toHaveLength(1);
    const paid = state.requests[0].event as Event;
    expect(paid.id).not.toBe(original.id);
    expect(state.requests[0].note).toBe(paid.id);
    expect(paid.tags).toContainEqual(["q", original.id, "", original.pubkey]);
    expect(paid.tags.some(tag => tag[0] === "e")).toBe(false);
    expect(state.frames).toEqual([]); expect(state.errors).toEqual([]);
});

test("an arbitrary URL containing a note ID remains a new link post", async ({ context, page }) => {
    const state = await setup(context, page);
    const url = `https://example.com/${noteEncode(original.id)}`;
    await page.getByRole("textbox", { name: "Text or link" }).fill(url);
    await expect(page.getByText("Your post", { exact: true })).toBeVisible();
    await expect(page.locator(".note-link-preview")).toHaveCount(1);
    await page.getByRole("button", { name: "Review post", exact: true }).click();
    await expect(page.getByRole("button", { name: "Add to board 210 sats", exact: true })).toBeEnabled();
    expect(state.signed?.content).toBe(url);
    expect(state.signed?.tags.some(tag => tag[0] === "q")).toBe(false);
    expect(state.links).toEqual([url]);
});

test("email OAuth preserves text and payment choices, signs exact content and revokes the session", async ({ context, page }) => {
    test.skip(process.env.VITE_ENABLE_EMAIL_ACCOUNTS !== "true");
    const state = await setup(context, page);
    await page.getByRole("textbox", { name: "Text or link" }).fill("A post from an email account");
    await page.getByRole("button", { name: "Custom", exact: true }).click();
    await page.getByRole("textbox", { name: "Custom total in sats" }).fill("333");
    await page.getByRole("button", { name: "Sign in / create account" }).click();
    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Sign in with email", exact: true }).click();
    const popup = await popupPromise;
    const callbackReads: string[] = [];
    popup.on("request", request => callbackReads.push(new URL(request.url()).pathname));
    await completeAccountPopup(popup);
    expect(callbackReads.some(path => path === "/src/App.tsx" || path.startsWith("/api/board"))).toBe(false);
    await expect(page.getByText("Author: Your account", { exact: true })).toBeVisible();
    expect(state.tokenRequests).toBe(1);
    await expect(page.getByRole("textbox", { name: "Custom total in sats" })).toHaveValue("333");
    await expect(page.getByRole("textbox", { name: "Text or link" })).toHaveValue("A post from an email account");
    await page.getByRole("button", { name: "Review post", exact: true }).click();
    await expect(page.getByRole("button", { name: "Add to board 333 sats", exact: true })).toBeEnabled();
    expect(state.signed?.pubkey).toBe(accountPubkey);
    expect(state.signed?.tags.some(tag => tag[0] === "l")).toBe(false);
    const logoutPopupPromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Sign out and revoke session" }).click();
    const logout = await logoutPopupPromise;
    await logout.getByRole("button", { name: "Revoke Holoboard session and sign out" }).click();
    await expect(page.getByText("Author: Anonymous", { exact: true })).toBeVisible();
    expect(state.revoked).toBe(true); expect(state.errors).toEqual([]);
});

test("rejects an OAuth callback with a mismatched state before token exchange", async ({ context, page }) => {
    test.skip(process.env.VITE_ENABLE_EMAIL_ACCOUNTS !== "true");
    const state = await setup(context, page); state.wrongState = true;
    await page.getByRole("textbox", { name: "Text or link" }).fill("Keep this draft after failed login");
    await page.getByRole("button", { name: "Sign in / create account" }).click();
    const opening = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Sign in with email", exact: true }).click();
    const popup = await opening;
    await popup.getByRole("button", { name: "Complete verified sign-in" }).click();
    await expect(popup.getByRole("status")).toContainText("Return to Holoboard");
    await popup.close();
    await expect(page.getByRole("alert")).toContainText("closed or expired");
    expect(state.tokenRequests).toBe(0);
    await expect(page.getByRole("textbox", { name: "Text or link" })).toHaveValue("Keep this draft after failed login");
});

test("the general action opens blank and resumes an original only after selection", async ({ context, page }) => {
    const state = await setup(context, page);
    await page.getByRole("textbox", { name: "Text or link" }).fill(noteEncode(original.id));
    await expect(page.getByRole("button", { name: "Add to board 210 sats", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Add to board 210 sats", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Promotion payment" })).toBeVisible();
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("button", { name: "Add to board", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Text or link" })).toHaveValue("");
    await expect(page.getByRole("dialog", { name: "Promotion payment" })).toHaveCount(0);
    await page.getByText("Unfinished payments", { exact: true }).click();
    await page.getByRole("button", { name: "Resume payment", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Promotion payment" })).toBeVisible();
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0].event).toBeUndefined();
    expect(state.frames).toEqual([]);
});

test("late email sign-in preserves already prepared guest invoices", async ({ context, page }) => {
    test.skip(process.env.VITE_ENABLE_EMAIL_ACCOUNTS !== "true");
    const state = await setup(context, page);
    await page.getByRole("textbox", { name: "Text or link" }).fill("Keep this guest invoice immutable");
    await page.getByRole("button", { name: "Review post", exact: true }).click();
    await expect(page.getByRole("button", { name: "Add to board 210 sats", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Sign in / create account" }).click();
    const opening = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Sign in with email", exact: true }).click();
    const popup = await opening;
    await popup.getByRole("button", { name: "Complete verified sign-in" }).waitFor();
    await page.getByRole("button", { name: "Add to board 210 sats", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Promotion payment" })).toBeVisible();
    const guest = state.requests[0].event as Event;
    await completeAccountPopup(popup);
    await expect.poll(() => state.tokenRequests).toBe(1);
    await expect(page.getByRole("dialog", { name: "Promotion payment" })).toBeVisible();
    expect(guest.pubkey).not.toBe(accountPubkey);
    state.paid = true;
    await expect(page.getByLabel("Promotion result")).toBeVisible();
    await page.getByRole("button", { name: "Make another payment", exact: true }).click();
    await expect(page.getByRole("button", { name: "Review post", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add to board 210 sats", exact: true })).toBeDisabled();
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0].event).toEqual(guest);
});

test("late email login cannot replace a more recently selected signer", async ({ context, page }) => {
    test.skip(process.env.VITE_ENABLE_EMAIL_ACCOUNTS !== "true" || process.env.VITE_ENABLE_NOSTR_CONNECT !== "true");
    const extensionPubkey = getPublicKey(generateSecretKey());
    await context.addInitScript(pubkey => {
        Object.assign(window, { nostr: { getPublicKey: async () => pubkey, signEvent: async () => { throw new Error("This check must not sign or publish."); } } });
    }, extensionPubkey);
    const state = await setup(context, page);
    await page.getByRole("textbox", { name: "Text or link" }).fill("Keep the newly selected author");
    await page.getByRole("button", { name: "Sign in / create account" }).click();
    const opening = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Sign in with email", exact: true }).click();
    const popup = await opening;
    await popup.getByRole("button", { name: "Complete verified sign-in" }).waitFor();
    await page.getByRole("button", { name: "Browser extension", exact: true }).click();
    await expect(page.getByText("Connected extension:", { exact: false })).toBeVisible();
    await completeAccountPopup(popup);
    await expect(page.getByRole("alert")).toContainText("Your account changed");
    expect(state.tokenRequests).toBe(0);
    const saved = await page.evaluate(() => ({ extension: JSON.parse(sessionStorage.getItem("holoboard-signer")!), keycast: sessionStorage.getItem("holoboard-keycast-session") }));
    expect(saved.extension.pubkey).toBe(extensionPubkey);
    expect(saved.keycast).toBeNull();
    expect(state.frames).toEqual([]);
});

test("email sign-in during invoice preparation keeps the frozen guest post", async ({ context, page }) => {
    test.skip(process.env.VITE_ENABLE_EMAIL_ACCOUNTS !== "true");
    const state = await setup(context, page);
    await page.getByRole("textbox", { name: "Text or link" }).fill("Keep this post while the invoice is prepared");
    await page.getByRole("button", { name: "Review post", exact: true }).click();
    await expect(page.getByRole("button", { name: "Add to board 210 sats", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Sign in / create account" }).click();
    const opening = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Sign in with email", exact: true }).click();
    const popup = await opening;
    await popup.getByRole("button", { name: "Complete verified sign-in" }).waitFor();
    state.pauseBoard = true;
    await page.getByRole("button", { name: "Add to board 210 sats", exact: true }).click();
    await expect.poll(() => typeof state.releaseBoard).toBe("function");
    const guest = state.requests[0].event as Event;
    try {
        await completeAccountPopup(popup);
        // The account RPC has its own 20-second deadline. Its connected state
        // establishes readiness before checking storage and releasing payment.
        await expect(page.getByRole("button", { name: "Sign out and revoke session" })).toBeVisible({ timeout: 20000 });
        await expect.poll(() => page.evaluate(() => sessionStorage.getItem("holoboard-keycast-session"))).not.toBeNull();
    } finally { state.releaseBoard!(); }
    await expect(page.getByRole("dialog", { name: "Promotion payment" })).toBeVisible();
    expect(state.requests).toHaveLength(1);
    expect(guest.pubkey).not.toBe(accountPubkey);
    expect(state.requests[0].note).toBe(guest.id);
    expect(state.errors).toEqual([]);
});
