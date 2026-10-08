import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event, type EventTemplate } from "nostr-tools/pure";
import { matchFilter } from "nostr-tools/filter";
import { decode } from "nostr-tools/nip19";
import * as nip44 from "nostr-tools/nip44";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });
const enabled = ["VITE_ENABLE_DISCUSSIONS", "VITE_ENABLE_NOSTR_CONNECT", "VITE_ENABLE_REPLY_PUBLICATION"].every(key => process.env[key] === "true");
const authorKey = generateSecretKey(), userKey = generateSecretKey(), transportKey = generateSecretKey();
const user = getPublicKey(userKey);
const make = (content: string, tags: string[][] = [], kind = 1) => finalizeEvent({ kind, created_at: 1700000000, tags, content }, authorKey);
const root = make("Original protocol root");
const focus = make("Promoted middle reply", [["e", root.id, "", "root"], ["e", root.id, "", "reply"]]);
const urls = ["wss://first.example.com/", "wss://second.example.com/"];
interface Options { remote?: boolean; slowSign?: boolean; missingParent?: boolean; article?: boolean; partial?: boolean; forged?: boolean; rejectAll?: boolean }
async function setup(context: BrowserContext, page: Page, options: Options = {}) {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const article = make("Addressable article", [["d", "article"]], 30023);
    const selected = options.article ? article : focus;
    const state = { writes: [] as { relay: string; event: Event }[], signatures: [] as EventTemplate[], errors: [] as string[], acceptAll: !options.partial, finishSign: undefined as (() => void) | undefined };
    const lists = [finalizeEvent({ kind: 10002, created_at: 1700000000, content: "", tags: urls.map(url => ["r", url, "write"]) }, userKey), make("", [["r", urls[0], "read"]], 10002)];
    const events = [selected, ...(!options.missingParent ? [root] : []), ...lists];
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.origin !== "http://127.0.0.1:3334") return route.abort();
        return route.fulfill({ json: { entries: [{ id: selected.id, event: selected, rank: 1, sats_paid: 210, weight: 200 }], targets: [], has_more: false, active_posts: 1, total: 1, count: 0, note_ids: [], checked_at: Date.now() } });
    });
    await context.routeWebSocket("**/*", socket => {
        if (socket.url().startsWith(origin.replace(/^http/, "ws"))) return socket.connectToServer();
        const subscriptions = new Map<string, Parameters<typeof matchFilter>[0][]>();
        const sendEvent = (event: Event) => {
            for (const [id, filters] of subscriptions) if (filters.some(filter => matchFilter(filter, event))) socket.send(JSON.stringify(["EVENT", id, event]));
        };
        socket.onMessage(async message => {
            const frame = JSON.parse(String(message));
            if (frame[0] === "CLOSE") { subscriptions.delete(frame[1]); return; }
            if (frame[0] === "REQ") {
                subscriptions.set(frame[1], frame.slice(2));
                if (options.remote && frame[2].kinds?.includes(24133) && !frame[2].authors) {
                    const uri = new URL((await page.getByRole("link", { name: "Open Amber / signer" }).getAttribute("href"))!);
                    expect(uri.searchParams.get("perms")).toBe("sign_event:9734,sign_event:1,sign_event:1111");
                    sendEvent(finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [["p", uri.hostname]], content: nip44.encrypt(JSON.stringify({ id: "connect", result: uri.searchParams.get("secret") }), nip44.getConversationKey(transportKey, uri.hostname)) }, transportKey));
                }
                for (const event of events) sendEvent(event);
                socket.send(JSON.stringify(["EOSE", frame[1]])); return;
            }
            if (frame[0] !== "EVENT") return;
            const event = frame[1] as Event; expect(verifyEvent(event)).toBe(true);
            if (event.kind === 24133) {
                const key = nip44.getConversationKey(transportKey, event.pubkey);
                const request = JSON.parse(nip44.decrypt(event.content, key));
                let result = "ack";
                if (request.method === "get_public_key") result = user;
                if (request.method === "switch_relays") result = "null";
                if (request.method === "sign_event") { const template = JSON.parse(request.params[0]); state.signatures.push(template); result = JSON.stringify(finalizeEvent(template, userKey)); }
                sendEvent(finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [["p", event.pubkey]], content: nip44.encrypt(JSON.stringify({ id: request.id, result }), key) }, transportKey));
                return;
            }
            expect([1, 1111]).toContain(event.kind);
            state.writes.push({ relay: socket.url(), event });
            if (options.rejectAll) socket.send(JSON.stringify(["OK", event.id, false, "blocked: fixture policy"]));
            else if (state.acceptAll || socket.url() !== urls[1]) socket.send(JSON.stringify(["OK", event.id, true, ""]));
        });
    });
    if (!options.remote) {
        await context.exposeFunction("fixtureReplySign", async (template: EventTemplate) => {
            state.signatures.push(template);
            if (options.slowSign) await new Promise<void>(resolve => { state.finishSign = resolve; });
            const event = finalizeEvent(template, userKey);
            return options.forged ? { ...event, content: "Forged signed text" } : event;
        });
        await context.addInitScript(pubkey => {
            const target = window as unknown as { nostr: unknown; fixtureReplySign(template: unknown): Promise<unknown> };
            target.nostr = { getPublicKey: async () => pubkey, signEvent: (template: unknown) => target.fixtureReplySign(template) };
        }, user);
    }
    page.on("pageerror", error => state.errors.push(error.message));
    await page.goto(`/discussion/${selected.id}?author=${selected.pubkey}`);
    if (process.env.VITE_ENABLE_DISCUSSIONS === "true") await expect(page.getByRole("article", { name: "Discussion focus" })).toContainText(selected.content);
    else await expect(page.locator("article").first()).toContainText(selected.content);
    return { state, selected };
}
async function open(page: Page) {
    await page.getByRole("article", { name: "Discussion focus" }).getByRole("button", { name: "Reply", exact: true }).click();
    return page.getByRole("dialog", { name: "Reply", exact: true });
}
async function prepare(page: Page, remote = false, content = "A reply to the original promoted note") {
    const dialog = await open(page);
    await dialog.getByRole("textbox", { name: "Reply text" }).fill(content);
    await dialog.getByRole("button", { name: remote ? "Connect Amber / remote signer" : "Connect browser extension", exact: true }).click();
    await expect(dialog.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible();
    await expect(page.getByRole("region", { name: "Discussion coverage" })).toHaveAttribute("data-read-state", /^(settled|paused)$/);
    await dialog.getByRole("button", { name: "Review reply", exact: true }).click();
    return dialog;
}

test("reply entry points require all three release flags", async ({ context, page }) => {
    test.skip(enabled);
    const { state } = await setup(context, page);
    await expect(page.getByRole("button", { name: "Reply", exact: true })).toHaveCount(0);
    expect(state.writes).toEqual([]); expect(state.signatures).toEqual([]);
});
test.describe("explicit reply publication", () => {
    test.skip(!enabled);
    for (const remote of [false, true]) test(`${remote ? "NIP-46" : "NIP-07"} signs the promoted middle reply but publishes only after destination consent`, async ({ context, page }) => {
        const { state } = await setup(context, page, { remote });
        const dialog = await prepare(page, remote);
        expect(state.writes).toEqual([]); expect(state.signatures).toEqual([]);
        await dialog.getByRole("button", { name: "Sign reply", exact: true }).click();
        await expect(dialog.getByRole("region", { name: "Reply delivery" })).toContainText("Saved locally. This reply has not been sent.");
        expect(state.writes).toEqual([]); expect(state.signatures).toHaveLength(1);
        expect(state.signatures[0].tags).toContainEqual(["e", root.id, "", "root", root.pubkey]);
        expect(state.signatures[0].tags).toContainEqual(["e", focus.id, "", "reply", focus.pubkey]);
        const publish = dialog.getByRole("button", { name: "Publish reply", exact: true });
        await expect(publish).toBeDisabled();
        await dialog.getByRole("checkbox", { name: /^I agree to publish/ }).check();
        await expect(publish).toBeEnabled();
        const box = (await publish.boundingBox())!;
        expect(box.y + box.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
        if (!remote) await page.screenshot({ path: `/private/tmp/holoboard-reply-review-${test.info().project.name}.png` });
        await publish.click();
        await expect(dialog.getByRole("region", { name: "Reply delivery" })).toContainText("Accepted by all selected relays.");
        expect(new Set(state.writes.map(value => value.event.id)).size).toBe(1);
        expect(state.writes.every(value => value.event.pubkey === user)).toBe(true);
        expect(state.signatures).toHaveLength(1);
        await dialog.getByRole("button", { name: "Done", exact: true }).click();
        await expect(page.getByRole("heading", { name: "0 found replies" })).toBeVisible();
        const receipt = await open(page);
        await receipt.getByRole("link", { name: "View reply", exact: true }).click();
        await expect(page).toHaveURL(/\/discussion\/nevent1/);
        const pointer = decode(new URL(page.url()).pathname.split("/")[2]);
        expect(pointer).toMatchObject({ type: "nevent", data: { id: state.writes[0].event.id, author: user } });
        if (pointer.type === "nevent") expect(pointer.data.relays?.length).toBeGreaterThan(0);
        await expect(page.getByRole("article", { name: "Discussion focus" })).toContainText("A reply to the original promoted note");
        await expect(page.getByRole("article", { name: "Discussion focus" }).getByText("Promoted", { exact: true })).toHaveCount(0);
        await expect(page.getByRole("region", { name: "Ancestor context" })).toContainText(root.content);
        expect(state.errors).toEqual([]);
    });
    test("restores partial delivery without sending, resets consent after account changes and retries the stored ID", async ({ context, page }) => {
        const { state } = await setup(context, page, { partial: true });
        let dialog = await prepare(page);
        await dialog.getByRole("button", { name: "Sign reply", exact: true }).click();
        await expect(dialog.getByRole("button", { name: "Publish reply", exact: true })).toBeVisible();
        await dialog.getByRole("checkbox", { name: /^I agree to publish/ }).check();
        await dialog.getByRole("button", { name: "Disconnect signer", exact: true }).click();
        await expect(dialog.getByRole("checkbox", { name: /^I agree to publish/ })).not.toBeChecked();
        await expect(dialog.getByRole("button", { name: "Publish reply", exact: true })).toBeDisabled();
        await dialog.getByRole("button", { name: "Connect browser extension", exact: true }).click();
        await expect(dialog.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible();
        await expect(dialog.getByRole("checkbox", { name: /^I agree to publish/ })).not.toBeChecked();
        await dialog.getByRole("checkbox", { name: /^I agree to publish/ }).check();
        await dialog.getByRole("button", { name: "Publish reply", exact: true }).click();
        await expect(dialog.getByRole("region", { name: "Reply delivery" })).toContainText("uncertain", { timeout: 15000 });
        const writes = state.writes.length, id = state.writes[0].event.id;
        await page.reload(); dialog = await open(page);
        await expect(dialog.getByRole("region", { name: "Reply delivery" })).toContainText("uncertain");
        expect(state.writes).toHaveLength(writes);
        await dialog.getByRole("button", { name: "Connect browser extension", exact: true }).click();
        await expect(dialog.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Retry saved reply", exact: true })).toBeDisabled();
        state.acceptAll = true;
        await dialog.getByRole("checkbox", { name: /^I agree to publish/ }).check();
        await dialog.getByRole("button", { name: "Retry saved reply", exact: true }).click();
        await expect(dialog.getByRole("region", { name: "Reply delivery" })).toContainText("Accepted by all selected relays.");
        expect(state.writes).toHaveLength(writes + 1); expect(state.writes.at(-1)).toMatchObject({ relay: urls[1], event: { id } });
        expect(state.signatures).toHaveLength(1); expect(state.errors).toEqual([]);
    });
    test("closing during signature approval preserves the draft and ignores the late signature", async ({ context, page }) => {
        const { state } = await setup(context, page, { slowSign: true });
        const dialog = await prepare(page);
        await dialog.getByRole("button", { name: "Sign reply", exact: true }).click();
        await expect.poll(() => !!state.finishSign).toBe(true);
        await dialog.getByRole("button", { name: "Close dialog", exact: true }).click(); state.finishSign!();
        const reopened = await open(page);
        await expect(reopened.getByRole("textbox", { name: "Reply text" })).toHaveValue("A reply to the original promoted note");
        await page.reload();
        await expect((await open(page)).getByRole("textbox", { name: "Reply text" })).toHaveValue("A reply to the original promoted note");
        expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
    });
    test("blocks unresolved parent context before requesting a signature", async ({ context, page }) => {
        const { state } = await setup(context, page, { missingParent: true });
        const dialog = await prepare(page);
        await expect(dialog.getByRole("alert")).toContainText("Reply context is incomplete or conflicting");
        await expect(dialog.getByRole("button", { name: "Sign reply", exact: true })).toHaveCount(0);
        expect(state.signatures).toEqual([]); expect(state.writes).toEqual([]);
    });
    test("signs NIP-22 article comments with stable address and exact version", async ({ context, page }) => {
        const { state, selected } = await setup(context, page, { article: true });
        const dialog = await prepare(page);
        await dialog.getByRole("button", { name: "Sign reply", exact: true }).click();
        await expect(dialog.getByRole("region", { name: "Reply delivery" })).toContainText("Saved locally");
        const template = state.signatures[0];
        expect(template.kind).toBe(1111);
        expect(template.tags).toContainEqual(["A", `30023:${selected.pubkey}:article`, ""]);
        expect(template.tags).toContainEqual(["E", selected.id, "", selected.pubkey]);
        expect(template.tags).toContainEqual(["e", selected.id, "", selected.pubkey]);
        expect(template.tags).toContainEqual(["K", "30023"]); expect(template.tags).toContainEqual(["k", "30023"]);
        expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
    });
    test("refuses a forged signer payload and leaves the draft editable", async ({ context, page }) => {
        const { state } = await setup(context, page, { forged: true });
        const dialog = await prepare(page);
        await dialog.getByRole("button", { name: "Sign reply", exact: true }).click();
        await expect(dialog.getByRole("alert")).toContainText("signer changed the requested event or account");
        await dialog.getByRole("button", { name: "Edit reply", exact: true }).click();
        await expect(dialog.getByRole("textbox", { name: "Reply text" })).toHaveValue("A reply to the original promoted note");
        expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
    });
    test("a failed native outbox write blocks publication and preserves the editable draft", async ({ context, page }) => {
        const { state } = await setup(context, page);
        const dialog = await prepare(page);
        await page.evaluate(() => {
            const transaction = IDBDatabase.prototype.transaction;
            IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
                if (this.name === "holoboard-public-outbox-v1" && args[1] === "readwrite") throw new DOMException("Fixture outbox quota", "QuotaExceededError");
                return transaction.apply(this, args);
            };
        });
        await dialog.getByRole("button", { name: "Sign reply", exact: true }).click();
        await expect(dialog.getByRole("alert")).toContainText("Fixture outbox quota");
        await expect(dialog.getByRole("button", { name: "Publish reply", exact: true })).toHaveCount(0);
        await dialog.getByRole("button", { name: "Return to draft", exact: true }).click();
        await expect(dialog.getByRole("textbox", { name: "Reply text" })).toHaveValue("A reply to the original promoted note");
        expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
    });
    test("another connected account cannot send a saved reply and forgetting its receipt never publishes", async ({ context, page }) => {
        const { state } = await setup(context, page);
        const dialog = await prepare(page);
        await dialog.getByRole("button", { name: "Sign reply", exact: true }).click();
        await expect(dialog.getByRole("region", { name: "Reply delivery" })).toContainText("Saved locally");
        await dialog.getByRole("button", { name: "Disconnect signer", exact: true }).click();
        await page.evaluate(pubkey => { (window as unknown as { nostr: { getPublicKey(): Promise<string> } }).nostr.getPublicKey = async () => pubkey; }, getPublicKey(generateSecretKey()));
        await dialog.getByRole("button", { name: "Connect browser extension", exact: true }).click();
        await expect(dialog.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible();
        await expect(dialog.getByRole("checkbox", { name: /^I agree to publish/ })).toBeDisabled();
        await expect(dialog.getByRole("button", { name: "Publish reply", exact: true })).toBeDisabled();
        await dialog.getByText("Manage local receipt", { exact: true }).click();
        await expect(dialog.getByRole("button", { name: "Forget local receipt", exact: true })).toBeDisabled();
        await dialog.getByRole("checkbox", { name: /^Forget this local receipt/ }).check();
        await dialog.getByRole("button", { name: "Forget local receipt", exact: true }).click();
        await expect(dialog.getByText("Saved replies (0/32)", { exact: true })).toBeVisible();
        await page.reload();
        await expect((await open(page)).getByRole("textbox", { name: "Reply text" })).toHaveValue("A reply to the original promoted note");
        expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
    });
    test("closing after wire delivery preserves an uncertain receipt and never resumes automatically", async ({ context, page }) => {
        const { state } = await setup(context, page, { partial: true });
        const dialog = await prepare(page);
        await dialog.getByRole("button", { name: "Sign reply", exact: true }).click();
        await dialog.getByRole("checkbox", { name: /^I agree to publish/ }).check();
        await dialog.getByRole("button", { name: "Publish reply", exact: true }).click();
        await expect.poll(() => state.writes.length).toBe(3);
        await expect(dialog.getByRole("region", { name: "Reply delivery" })).toContainText("Sending reply. Outcomes are not final.");
        await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
        const reopened = await open(page);
        await expect(reopened.getByRole("region", { name: "Reply delivery" })).toContainText("uncertain");
        await expect(reopened.getByRole("button", { name: "Retry saved reply", exact: true })).toBeDisabled();
        expect(state.writes).toHaveLength(3); expect(state.signatures).toHaveLength(1); expect(state.errors).toEqual([]);
    });
    test("shows relay rejection separately from an uncertain attempt", async ({ context, page }) => {
        const { state } = await setup(context, page, { rejectAll: true });
        const dialog = await prepare(page);
        await dialog.getByRole("button", { name: "Sign reply", exact: true }).click();
        await dialog.getByRole("checkbox", { name: /^I agree to publish/ }).check();
        await dialog.getByRole("button", { name: "Publish reply", exact: true }).click();
        const delivery = dialog.getByRole("region", { name: "Reply delivery" });
        await expect(delivery).toContainText("No selected relay accepted this reply.");
        await expect(delivery.getByRole("listitem")).toHaveCount(3);
        expect(await delivery.getByRole("listitem").allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining("rejected (blocked: fixture policy)")]));
        await expect(delivery.getByRole("status")).not.toContainText("uncertain");
        await expect(dialog.getByRole("button", { name: "Retry saved reply", exact: true })).toBeDisabled();
        expect(state.signatures).toHaveLength(1); expect(state.errors).toEqual([]);
    });
});
