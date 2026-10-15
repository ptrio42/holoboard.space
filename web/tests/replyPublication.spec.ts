import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event, type EventTemplate } from "nostr-tools/pure";
import { matchFilter } from "nostr-tools/filter";
import { decode } from "nostr-tools/nip19";
import * as nip44 from "nostr-tools/nip44";
import { createHash } from "node:crypto";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });
const enabled = ["VITE_ENABLE_DISCUSSIONS", "VITE_ENABLE_NOSTR_CONNECT", "VITE_ENABLE_REPLY_PUBLICATION"].every(key => process.env[key] === "true");
const authorKey = generateSecretKey(), userKey = generateSecretKey(), transportKey = generateSecretKey();
const user = getPublicKey(userKey);
const make = (content: string, tags: string[][] = [], kind = 1) => finalizeEvent({ kind, created_at: 1700000000, tags, content }, authorKey);
const root = make("Original protocol root");
const focus = make("Promoted middle reply", [["e", root.id, "", "root"], ["e", root.id, "", "reply"]]);
const urls = ["wss://first.example.com/", "wss://second.example.com/"];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
interface Options { remote?: boolean; slowSign?: boolean; missingParent?: boolean; article?: boolean; partial?: boolean; forged?: boolean; rejectAll?: boolean; uploadFailure?: number; wrongUploadHash?: boolean; gifUnavailable?: boolean; queuedUpload?: boolean }
async function setup(context: BrowserContext, page: Page, options: Options = {}) {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const article = make("Addressable article", [["d", "article"]], 30023);
    const selected = options.article ? article : focus;
    const state = { writes: [] as { relay: string; event: Event }[], signatures: [] as EventTemplate[], uploads: [] as { url: string; auth: Event }[], processingReads: [] as Event[], gifRequests: 0, errors: [] as string[], acceptAll: !options.partial, finishSign: undefined as (() => void) | undefined };
    const lists = [finalizeEvent({ kind: 10002, created_at: 1700000000, content: "", tags: urls.map(url => ["r", url, "write"]) }, userKey), make("", [["r", urls[0], "read"]], 10002)];
    const events = [selected, ...(!options.missingParent ? [root] : []), ...lists];
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.hostname === "gifs.nostr.build" && url.pathname === "/api/v1/search") {
            state.gifRequests++;
            if (options.gifUnavailable) return route.fulfill({ status: 503, json: { error: "Fixture GIF outage" } });
            return route.fulfill({ json: { items: [{ url: "https://gifs.nostr.build/reaction.gif", title: "Happy reaction", previews: { w240: { still: "https://gifs.nostr.build/still/reaction.gif" } } }] } });
        }
        if (url.hostname === "nostrcheck.me" && url.pathname === "/.well-known/nostr/nip96.json") return route.fulfill({ json: { api_url: "https://cdn.nostrcheck.me", content_types: ["image/png"], plans: { free: { max_byte_size: 104857600 } } } });
        if (url.href === "https://cdn.nostrcheck.me/job/42" && route.request().method() === "GET") {
            const auth = JSON.parse(Buffer.from(route.request().headers().authorization.replace(/^Nostr /, ""), "base64").toString()) as Event;
            expect(verifyEvent(auth)).toBe(true); expect(auth.pubkey).toBe(user); expect(auth.kind).toBe(27235);
            expect(auth.tags).toEqual([["u", url.href], ["method", "GET"]]);
            expect(state.processingReads.some(previous => previous.id === auth.id)).toBe(false);
            state.processingReads.push(auth);
            if (state.processingReads.length === 1) return route.fulfill({ json: { status: "processing", percentage: 25 } });
            const hash = createHash("sha256").update(png).digest("hex");
            return route.fulfill({ status: 201, json: { status: "success", processing_url: "", nip94_event: { tags: [
                ["url", `https://cdn.nostrcheck.me/${hash}.png`], ["ox", hash], ["x", hash], ["m", "image/png"]] } } });
        }
        if (["blossom.primal.net", "blossom.nostr.build", "media.example.com", "cdn.nostrcheck.me"].includes(url.hostname) && ["PUT", "POST"].includes(route.request().method())) {
            const header = route.request().headers().authorization?.replace(/^Nostr /, "");
            const auth = JSON.parse(Buffer.from(header!, "base64url").toString()) as Event;
            expect(verifyEvent(auth)).toBe(true); expect(auth.pubkey).toBe(user);
            state.uploads.push({ url: url.href, auth });
            if (options.uploadFailure) return route.fulfill({ status: options.uploadFailure, json: { error: "Fixture upload failure" } });
            const blossom = route.request().method() === "PUT";
            const bytes = route.request().postDataBuffer();
            // WebKit's inspector omits File request bodies. Compare its signed
            // hash with the known fixture; Chromium also verifies the wire bytes.
            const hash = createHash("sha256").update(blossom && bytes ? bytes : png).digest("hex");
            const fileUrl = `${url.origin}/${hash}.png`;
            expect(auth.kind).toBe(blossom ? 24242 : 27235);
            if (blossom) {
                if (url.hostname === "blossom.primal.net") {
                    expect(header).toMatch(/^[A-Za-z0-9+/]+={0,2}$/); expect(header!.length % 4).toBe(0);
                } else expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
                expect(auth.tags).toContainEqual(["x", hash]); expect(auth.tags).toContainEqual(["server", url.hostname]);
                return route.fulfill({ status: 201, json: { url: fileUrl, sha256: options.wrongUploadHash ? "f".repeat(64) : hash, size: bytes?.length ?? png.length, type: "image/png" } });
            }
            expect(auth.tags).toContainEqual(["u", url.href]); expect(auth.tags).toContainEqual(["method", "POST"]);
            expect(auth.tags).toContainEqual(["payload", hash]);
            if (options.queuedUpload) return route.fulfill({ status: 202, json: { status: "success", processing_url: "https://cdn.nostrcheck.me/job/42", payment_request: "" } });
            return route.fulfill({ status: 201, json: { status: "success", nip94_event: { tags: [["url", fileUrl], ["ox", hash], ["x", hash], ["m", "image/png"]] } } });
        }
        if (["gifs.nostr.build", "blossom.primal.net", "blossom.nostr.build", "cdn.nostrcheck.me", "media.example.com"].includes(url.hostname) && route.request().method() === "GET") return route.fulfill({ contentType: "image/png", body: png });
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
                    expect(uri.searchParams.get("perms")).toBe("sign_event:9734,sign_event:1,sign_event:1111,sign_event:24242,sign_event:27235");
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
    test("composer tools insert at the caret, preview and preserve drafts on desktop and narrow phones", async ({ context, page }) => {
        const { state } = await setup(context, page);
        let dialog = await open(page);
        const field = dialog.getByRole("textbox", { name: "Reply text" });
        await field.fill("Before after");
        await field.evaluate((element: HTMLTextAreaElement) => { element.setSelectionRange(7, 7); element.dispatchEvent(new Event("select", { bubbles: true })); });
        await dialog.getByRole("button", { name: "Emoji", exact: true }).click();
        await dialog.getByRole("button", { name: "happy smile", exact: true }).click();
        await expect(field).toHaveValue("Before 😀after");
        await dialog.getByRole("button", { name: "GIF", exact: true }).click();
        await dialog.getByRole("searchbox", { name: "Search GIFs" }).fill("happy");
        await dialog.getByRole("button", { name: "Search", exact: true }).click();
        await dialog.getByRole("button", { name: "Insert Happy reaction", exact: true }).click();
        await expect(field).toHaveValue(/https:\/\/gifs.nostr.build\/reaction.gif/);
        const draft = await field.inputValue();
        await dialog.getByRole("tab", { name: "Preview", exact: true }).click();
        await expect(dialog.getByRole("region", { name: "Draft preview" })).toContainText("Before 😀");
        await expect(dialog.getByRole("region", { name: "Draft preview" }).locator("img")).toHaveCount(1);
        await dialog.getByRole("tab", { name: "Write", exact: true }).click();
        for (const width of test.info().project.name === "desktop" ? [1280, 390, 320] : [390, 320]) {
            await page.setViewportSize({ width, height: width > 600 ? 900 : 800 });
            const action = dialog.getByRole("button", { name: "Review reply", exact: true });
            const box = (await action.boundingBox())!;
            expect(box.y + box.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
            expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
            expect(await field.evaluate(element => getComputedStyle(element).fontSize)).toBe("16px");
            await page.screenshot({ path: `/private/tmp/holoboard-composer-${test.info().project.name}-${width}.png` });
        }
        await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
        await page.reload(); dialog = await open(page);
        await expect(dialog.getByRole("textbox", { name: "Reply text" })).toHaveValue(draft);
        expect(state.gifRequests).toBe(1); expect(state.uploads).toEqual([]); expect(state.writes).toEqual([]); expect(state.signatures).toEqual([]); expect(state.errors).toEqual([]);
    });
    test("uploads through all built-in servers and restores descriptions before an explicit signed reply", async ({ context, page }) => {
        const { state } = await setup(context, page);
        let dialog = await open(page);
        await dialog.getByRole("textbox", { name: "Reply text" }).fill("Attachments for this reply");
        await dialog.getByRole("button", { name: "Connect browser extension", exact: true }).click();
        for (const server of ["primal", "build", "check"]) {
            await dialog.getByLabel("Choose attachments").setInputFiles({ name: `${server}.png`, mimeType: "image/png", buffer: png });
            await dialog.getByRole("combobox", { name: "Upload server" }).selectOption(server);
            await dialog.getByRole("textbox", { name: `Description for ${server}.png`, exact: true }).fill(`Description ${server}`);
            await expect(dialog.getByRole("button", { name: "Review reply", exact: true })).toBeDisabled();
            expect((await dialog.getByRole("button", { name: "Upload file", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
            await dialog.getByRole("button", { name: "Upload file", exact: true }).click();
            await expect(dialog.getByRole("list", { name: "Selected files" })).toHaveCount(0);
        }
        await expect(dialog.getByRole("list", { name: "Uploaded attachments" }).getByRole("listitem")).toHaveCount(3);
        expect(state.signatures.map(value => value.kind)).toEqual([24242, 24242, 27235]); expect(state.writes).toEqual([]);
        await dialog.getByRole("button", { name: "Close dialog", exact: true }).click(); await page.reload(); dialog = await open(page);
        await expect.poll(() => dialog.getByRole("list", { name: "Uploaded attachments" }).getByRole("textbox").evaluateAll(elements => elements.map(element => (element as HTMLInputElement).value))).toEqual(["Description primal", "Description build", "Description check"]);
        await dialog.getByRole("button", { name: "Connect browser extension", exact: true }).click();
        await dialog.getByRole("button", { name: "Review reply", exact: true }).click();
        await dialog.getByRole("button", { name: "Sign reply", exact: true }).click();
        await expect(dialog.getByRole("region", { name: "Reply delivery" })).toContainText("Saved locally");
        await expect(dialog.getByText("Signed and saved locally", { exact: true })).toBeVisible();
        const signed = state.signatures.at(-1)!;
        expect(signed.tags.filter(tag => tag[0] === "imeta")).toHaveLength(3);
        expect(signed.tags).toContainEqual(["e", focus.id, "", "reply", focus.pubkey]);
        expect(state.writes).toEqual([]); expect(state.uploads).toHaveLength(3); expect(state.errors).toEqual([]);
    });
    test("completes queued nostrcheck.me processing with one transfer and fresh scoped read signatures", async ({ context, page }) => {
        const { state } = await setup(context, page, { queuedUpload: true });
        const dialog = await open(page);
        await dialog.getByRole("textbox", { name: "Reply text" }).fill("Keep this draft while processing");
        await dialog.getByRole("button", { name: "Connect browser extension", exact: true }).click();
        await dialog.getByLabel("Choose attachments").setInputFiles({ name: "queued.png", mimeType: "image/png", buffer: png });
        await dialog.getByRole("combobox", { name: "Upload server" }).selectOption("check");
        await dialog.getByRole("textbox", { name: "Description for queued.png", exact: true }).fill("Queued attachment");
        await dialog.getByRole("button", { name: "Upload file", exact: true }).click();
        await expect(dialog.getByRole("list", { name: "Selected files" })).toHaveCount(0);
        await expect(dialog.getByRole("list", { name: "Uploaded attachments" }).getByRole("listitem")).toHaveCount(1);
        await expect(dialog.getByRole("textbox", { name: "Reply text" })).toHaveValue(/^Keep this draft while processing\nhttps:\/\/cdn\.nostrcheck\.me\//);
        expect(state.uploads).toHaveLength(1); expect(state.processingReads).toHaveLength(2);
        expect(state.processingReads[0].id).not.toBe(state.processingReads[1].id);
        expect(state.signatures).toHaveLength(3); expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
    });
    for (const options of [{ uploadFailure: 402 }, { wrongUploadHash: true }]) test(`keeps files and text recoverable after ${options.uploadFailure ? "paid-server rejection" : "a mismatched upload hash"}`, async ({ context, page }) => {
        const { state } = await setup(context, page, options);
        const dialog = await open(page);
        await dialog.getByRole("textbox", { name: "Reply text" }).fill("Keep this draft");
        await dialog.getByRole("button", { name: "Connect browser extension", exact: true }).click();
        await dialog.getByLabel("Choose attachments").setInputFiles({ name: "image.png", mimeType: "image/png", buffer: png });
        await dialog.getByRole("button", { name: "Upload file", exact: true }).click();
        await expect(dialog.getByRole("alert")).toContainText(options.uploadFailure ? "requires payment" : "does not match");
        await expect(dialog.getByRole("textbox", { name: "Reply text" })).toHaveValue("Keep this draft");
        await expect(dialog.getByRole("list", { name: "Uploaded attachments" })).toHaveCount(0);
        await dialog.getByRole("button", { name: "Remove image.png", exact: true }).click();
        await expect(dialog.getByRole("button", { name: "Review reply", exact: true })).toBeEnabled();
        expect(state.uploads).toHaveLength(1); expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
    });
    test("closing while upload approval is pending cannot upload or add a late URL", async ({ context, page }) => {
        const { state } = await setup(context, page, { slowSign: true });
        const dialog = await open(page);
        await dialog.getByRole("textbox", { name: "Reply text" }).fill("Draft before upload");
        await dialog.getByRole("button", { name: "Connect browser extension", exact: true }).click();
        await dialog.getByLabel("Choose attachments").setInputFiles({ name: "image.png", mimeType: "image/png", buffer: png });
        await dialog.getByRole("button", { name: "Upload file", exact: true }).click();
        await expect.poll(() => state.signatures.length).toBe(1);
        await dialog.getByRole("button", { name: "Close dialog", exact: true }).click(); state.finishSign!();
        const reopened = await open(page);
        await expect(reopened.getByRole("textbox", { name: "Reply text" })).toHaveValue("Draft before upload");
        expect(state.uploads).toEqual([]); expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
    });
    test("stages pasted and dropped files locally and enforces the attachment limit", async ({ context, page }) => {
        const { state } = await setup(context, page);
        const dialog = await open(page);
        const field = dialog.getByRole("textbox", { name: "Reply text" });
        await field.evaluate((element, bytes) => {
            const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" }));
            element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        }, [...png]);
        await dialog.getByRole("region", { name: "Note editor", exact: true }).evaluate((element, bytes) => {
            const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], "dropped.png", { type: "image/png" }));
            element.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
        }, [...png]);
        await expect(dialog.getByRole("list", { name: "Selected files" }).getByRole("listitem")).toHaveCount(2);
        await dialog.getByLabel("Choose attachments").setInputFiles(Array.from({ length: 7 }, (_, index) => ({ name: `${index}.png`, mimeType: "image/png", buffer: png })));
        await expect(dialog.getByRole("alert")).toContainText("at most eight");
        await expect(dialog.getByRole("list", { name: "Selected files" }).getByRole("listitem")).toHaveCount(2);
        expect(state.uploads).toEqual([]); expect(state.signatures).toEqual([]); expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
    });
    test("uses a custom Blossom server with NIP-46 upload permission without publishing", async ({ context, page }) => {
        const { state } = await setup(context, page, { remote: true });
        const dialog = await open(page);
        await dialog.getByRole("button", { name: "Connect Amber / remote signer", exact: true }).click();
        await expect(dialog.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible();
        await dialog.getByLabel("Choose attachments").setInputFiles({ name: "custom.png", mimeType: "image/png", buffer: png });
        await dialog.getByRole("combobox", { name: "Upload server" }).selectOption("custom");
        await dialog.getByRole("textbox", { name: "Blossom server", exact: true }).fill("https://media.example.com");
        await dialog.getByRole("button", { name: "Upload file", exact: true }).click();
        await expect(dialog.getByRole("list", { name: "Uploaded attachments" }).getByRole("listitem")).toHaveCount(1);
        expect(state.uploads[0].url).toBe("https://media.example.com/upload");
        expect(state.signatures.map(value => value.kind)).toEqual([24242]); expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
    });
    test("keeps a direct GIF fallback when search fails", async ({ context, page }) => {
        const { state } = await setup(context, page, { gifUnavailable: true });
        const dialog = await open(page);
        await dialog.getByRole("button", { name: "GIF", exact: true }).click();
        await dialog.getByRole("button", { name: "Search", exact: true }).click();
        await expect(dialog.getByRole("alert")).toContainText("GIF search is unavailable");
        await dialog.getByRole("textbox", { name: "GIF link", exact: true }).fill("https://gifs.nostr.build/reaction.gif");
        await dialog.getByRole("button", { name: "Add", exact: true }).click();
        await expect(dialog.getByRole("textbox", { name: "Reply text" })).toHaveValue("https://gifs.nostr.build/reaction.gif");
        expect(state.uploads).toEqual([]); expect(state.signatures).toEqual([]); expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
    });
    test("bounds emoji bytes, keeps the footer usable at keyboard height and reviews with a shortcut", async ({ context, page }) => {
        const { state } = await setup(context, page);
        const dialog = await open(page), field = dialog.getByRole("textbox", { name: "Reply text" });
        await field.fill("😀".repeat(4097));
        await expect(dialog.getByRole("alert").filter({ hasText: "exceeds 16 KiB" })).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Review reply", exact: true })).toBeDisabled();
        await field.fill("Draft with a shorter viewport");
        await page.setViewportSize({ width: 390, height: 430 });
        const box = (await dialog.getByRole("button", { name: "Review reply", exact: true }).boundingBox())!;
        expect(box.y + box.height).toBeLessThanOrEqual(430);
        await expect(dialog.getByRole("button", { name: "Review reply", exact: true })).toBeEnabled();
        await expect(page.getByRole("region", { name: "Discussion coverage" })).toHaveAttribute("data-read-state", /^(settled|paused)$/);
        await field.press("Control+Enter");
        await expect(dialog.getByRole("region", { name: "Reply preview", exact: true })).toContainText("Draft with a shorter viewport");
        expect(state.signatures).toEqual([]); expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
    });
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
        await page.getByRole("region", { name: "Ancestor context" }).getByRole("button", { name: /Earlier context/ }).click();
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
