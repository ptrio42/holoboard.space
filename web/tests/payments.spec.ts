import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import * as nip04 from "nostr-tools/nip04";
import { neventEncode, npubEncode } from "nostr-tools/nip19";
import { bytesToHex } from "nostr-tools/utils";
import jsQR from "jsqr";
import { PNG } from "pngjs";

// Route-based API mocks cannot intercept requests owned by a service worker.
// The PWA suite exercises worker updates with a real local mock API instead.
test.use({ serviceWorkers: "block" });

const walletKey = generateSecretKey(), signerKey = generateSecretKey(), userKey = generateSecretKey();
const walletPubkey = getPublicKey(walletKey);
const clientKey = generateSecretKey();
const note = finalizeEvent({ kind: 1, created_at: 1700000000, tags: [], content: "A note for isolated payment tests." }, userKey);
const boardPreimage = "b".repeat(64), authorPreimage = "c".repeat(64);
const hash = (preimage: string) => createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
const boardHash = hash(boardPreimage), authorHash = hash(authorPreimage);
const walletUri = `nostr+walletconnect://${walletPubkey}?relay=ws%3A%2F%2F127.0.0.1%3A3334&secret=${bytesToHex(clientKey)}`;
type Options = { mockInvoice?: boolean; noteContent?: string; rank?: number; targets?: { rank: number; weight: number }[]; authorMinSats?: number; authorShare?: number; newCampaign?: boolean; expiredCampaign?: boolean; authorUnavailable?: "no_address" | "unavailable"; blockStorage?: boolean; encryption?: "nip44_v2" | "nip04"; failAuthor?: boolean; loseAuthorResponse?: boolean; failAuthorInvoice?: boolean; extension?: boolean; deferSigner?: boolean; authorExpiresIn?: number; boardExpiresIn?: number; webln?: boolean; lookupState?: "pending" | "unknown" };

async function setup(context: BrowserContext, page: Page, options: Options = {}) {
    const appOrigin = new URL(test.info().project.use.baseURL!).origin;
    const appSocket = appOrigin.replace(/^http/, "ws");
    const promotedNote = options.noteContent ? finalizeEvent({ kind: 1, created_at: 1700000000, tags: [], content: options.noteContent }, userKey) : note;
    if (options.blockStorage) await context.addInitScript(() => {
        Object.defineProperty(window, "sessionStorage", { get: () => { throw new DOMException("Storage blocked by this test", "SecurityError"); } });
    });
    const state = { boardPaid: false, authorPaid: false, boardCharges: 0, authorCharges: 0, authorAttempts: 0, expectedSignerPubkey: getPublicKey(userKey), boardRequests: [] as Record<string, unknown>[], authorRequests: [] as Record<string, unknown>[], methods: [] as string[], signerMethods: [] as string[], errors: [] as string[], approveSigner: undefined as (() => Promise<void>) | undefined };
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
    await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === appOrigin) return route.continue();
        if (url.origin !== "http://127.0.0.1:3334") return route.abort();
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (url.pathname === "/preview-image.png") {
            if (url.searchParams.has("broken")) return route.fulfill({ status: 404, headers, body: "Image unavailable" });
            const image = new PNG({ width: 32, height: 24 }); image.data.fill(255);
            return route.fulfill({ headers, contentType: "image/png", body: PNG.sync.write(image) });
        }
        const body = route.request().postDataJSON();
        let data: unknown;
        let status = 200;
        const entry = { event: promotedNote, id: promotedNote.id, rank: options.rank ?? 1, sats_paid: 210, weight: 200, first_paid_at: 1700000000, hot_sats: 21, author_share: options.authorShare ?? 20 };
        if (url.pathname === "/api/board/campaigns") data = { entries: [entry], targets: options.targets ?? [entry], total: 1, active_posts: 1, has_more: false, total_sats: 210 };
        else if (url.pathname === "/api/promote/preview") data = { event: promotedNote, active: !options.newCampaign && !options.expiredCampaign, sats_paid: options.newCampaign ? 0 : 210, weight: options.newCampaign || options.expiredCampaign ? 0 : 200, rank: options.newCampaign || options.expiredCampaign ? 0 : options.rank ?? 1, billboard_fee_sats: 100, images: [], author_share: entry.author_share };
        else if (url.pathname === "/api/support") data = { available: !options.authorUnavailable, reason_code: options.authorUnavailable, reason: options.authorUnavailable === "no_address" ? "The author has no Lightning payment address." : "Author support is unavailable. Choose visibility only or try again later.", author: note.pubkey, min_sats: options.authorMinSats ?? 1, max_sats: 10000000, allows_nostr: true, nostr_pubkey: walletPubkey };
        else if (url.pathname === "/api/support/invoice") {
            state.authorRequests.push(body);
            if (options.failAuthorInvoice) { status = 503; data = { error: "Author invoice provider unavailable" }; }
            else {
                if (body.zap_request) { expect(verifyEvent(body.zap_request)).toBe(true); expect(body.zap_request.kind).toBe(9734); expect(body.zap_request.pubkey).toBe(state.expectedSignerPubkey); }
                data = { invoice: "lnbc-author", payment_hash: authorHash, amount_sats: body.amount_sats, author: note.pubkey, expires_at: Math.floor(Date.now()/1000)+(options.authorExpiresIn ?? 3600) };
            }
        } else if (url.pathname === "/api/promote") {
            state.boardRequests.push(body);
            data = { invoice: options.mockInvoice ? `lnbc${body.amount_sats}...mock_invoice` : "lnbc-visibility", payment_hash: boardHash, amount_sats: body.amount_sats + (body.billboard ? 100 : 0), promotion_sats: body.amount_sats, note_id: promotedNote.id, expires_at: Math.floor(Date.now()/1000)+(options.boardExpiresIn ?? 3600), billboard_fee_sats: body.billboard ? 100 : 0 };
        } else if (url.pathname === "/api/promote/status") data = { pending: !state.boardPaid, settled: state.boardPaid, sats_paid: 210, ...(state.boardPaid ? { receipt: { promotion_sats: state.boardRequests.at(-1)?.amount_sats, fee_converted: false, billboard_applied: false } } : {}) };
        else if (url.pathname === "/api/support/verify") { expect(body.preimage).toBe(authorPreimage); data = { verified: true }; }
        else throw new Error(`Unexpected payment test request: ${url.pathname}`);
        await route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(data) });
    });
    await context.routeWebSocket("**/*", (socket) => {
        if (socket.url().startsWith(appSocket)) return socket.connectToServer();
        if (!socket.url().startsWith("ws://127.0.0.1:3334")) { socket.close(); return; }
        const subscriptions = new Map<string, Record<string, unknown>>();
        const sendEvent = (event: Event) => {
            for (const [id, filter] of subscriptions) {
                if (!(filter.kinds as number[] | undefined)?.includes(event.kind)) continue;
                if (filter.authors && !(filter.authors as string[]).includes(event.pubkey)) continue;
                if (filter["#e"] && !(filter["#e"] as string[]).some((value) => event.tags.some((tag) => tag[0] === "e" && tag[1] === value))) continue;
                if (filter["#p"] && !(filter["#p"] as string[]).some((value) => event.tags.some((tag) => tag[0] === "p" && tag[1] === value))) continue;
                socket.send(JSON.stringify(["EVENT", id, event]));
            }
        };
        socket.onMessage(async (message) => {
            const msg = JSON.parse(String(message));
            if (msg[0] === "CLOSE") { subscriptions.delete(msg[1]); return; }
            if (msg[0] === "REQ") {
                const filter = msg[2]; subscriptions.set(msg[1], filter);
                if (filter.kinds?.includes(13194)) sendEvent(finalizeEvent({ kind: 13194, created_at: Math.floor(Date.now()/1000), tags: options.encryption === "nip04" ? [] : [["encryption", "nip44_v2 nip04"]], content: "get_info pay_invoice lookup_invoice" }, walletKey));
                if (filter.kinds?.includes(24133) && !filter.authors) {
                    state.approveSigner = async () => {
                        const uri = new URL((await page.getByRole("link", { name: "Open Amber / signer" }).getAttribute("href"))!);
                        const client = uri.hostname;
                        expect(uri.searchParams.get("perms")).toBe("sign_event:9734");
                        sendEvent(finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now()/1000), tags: [["p", client]], content: nip44.encrypt(JSON.stringify({ id: "connect", result: uri.searchParams.get("secret") }), nip44.getConversationKey(signerKey, client)) }, signerKey));
                    };
                    if (!options.deferSigner) await state.approveSigner();
                }
                socket.send(JSON.stringify(["EOSE", msg[1]]));
                return;
            }
            if (msg[0] !== "EVENT") return;
            const event = msg[1] as Event;
            expect(verifyEvent(event)).toBe(true);
            socket.send(JSON.stringify(["OK", event.id, true, ""]));
            if (event.kind === 23194) {
                const encryption = event.tags.find((tag) => tag[0] === "encryption")?.[1];
                expect(encryption).toBe(options.encryption ?? "nip44_v2");
                const key = nip44.getConversationKey(walletKey, event.pubkey);
                const request = JSON.parse(encryption === "nip04" ? await nip04.decrypt(bytesToHex(walletKey), event.pubkey, event.content) : nip44.decrypt(event.content, key));
                state.methods.push(request.method);
                let result: unknown, error: unknown = null;
                if (request.method === "get_info") result = { alias: "Test NWC wallet", network: "mainnet", methods: ["pay_invoice", "lookup_invoice", "get_info"] };
                else if (request.method === "pay_invoice") {
                    if (request.params.invoice === "lnbc-visibility") { state.boardCharges++; state.boardPaid = true; result = { preimage: boardPreimage }; }
                    else {
                        state.authorAttempts++;
                        if (options.failAuthor && state.authorAttempts === 1) error = { code: "PAYMENT_FAILED", message: "Author payment failed" };
                        else { state.authorCharges++; state.authorPaid = true; result = { preimage: authorPreimage }; }
                        if (options.loseAuthorResponse && state.authorAttempts === 1) return;
                    }
                } else if (request.method === "lookup_invoice") {
                    if (options.lookupState === "unknown") error = { code: "NOT_FOUND", message: "No status available" };
                    else result = { invoice: "lnbc-author", type: "outgoing", payment_hash: request.params.payment_hash, state: options.lookupState ?? (state.authorPaid ? "settled" : "failed"), settled_at: options.lookupState ? 0 : state.authorPaid ? Math.floor(Date.now()/1000) : 0, preimage: options.lookupState ? undefined : state.authorPaid ? authorPreimage : undefined };
                }
                else throw new Error(`Unexpected NWC method: ${request.method}`);
                const plaintext = JSON.stringify({ result_type: request.method, result, error });
                const content = encryption === "nip04" ? await nip04.encrypt(bytesToHex(walletKey), event.pubkey, plaintext) : nip44.encrypt(plaintext, key);
                sendEvent(finalizeEvent({ kind: 23195, created_at: Math.floor(Date.now()/1000), tags: [["p", event.pubkey], ["e", event.id]], content }, walletKey));
            } else if (event.kind === 24133) {
                const key = nip44.getConversationKey(signerKey, event.pubkey);
                const request = JSON.parse(nip44.decrypt(event.content, key)); state.signerMethods.push(request.method);
                const result = request.method === "get_public_key" ? getPublicKey(userKey) : request.method === "sign_event" ? JSON.stringify(finalizeEvent(JSON.parse(request.params[0]), userKey)) : request.method === "switch_relays" ? "null" : "ack";
                sendEvent(finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now()/1000), tags: [["p", event.pubkey]], content: nip44.encrypt(JSON.stringify({ id: request.id, result }), key) }, signerKey));
            }
        });
    });
    if (options.extension) await context.addInitScript(({ secret, pubkey }) => {
        // The test extension exposes no private key to application code.
        (window as unknown as { nostr: unknown }).nostr = {
            getPublicKey: async () => pubkey,
            signEvent: async (template: unknown) => (window as unknown as { testSignEvent: (template: unknown, secret: number[]) => Promise<unknown> }).testSignEvent(template, secret),
        };
    }, { secret: Array.from(userKey), pubkey: getPublicKey(userKey) });
    if (options.extension) await page.exposeFunction("testSignEvent", (template: Parameters<typeof finalizeEvent>[0], secret: number[]) => {
        state.signerMethods.push("extension:sign_event");
        return finalizeEvent(template, Uint8Array.from(secret));
    });
    if (options.webln) {
        await context.exposeFunction("testWalletPay", async (invoice: string) => {
            if (invoice === "lnbc-visibility") { state.boardCharges++; state.boardPaid = true; return { preimage: boardPreimage }; }
            expect(invoice).toBe("lnbc-author"); state.authorAttempts++; state.authorCharges++; state.authorPaid = true;
            return { preimage: authorPreimage };
        });
        await context.addInitScript(() => {
            const target = window as unknown as { webln: unknown; testWalletPay(invoice: string): Promise<unknown> };
            target.webln = { enable: async () => {}, sendPayment: (invoice: string) => target.testWalletPay(invoice) };
        });
    }
    page.on("pageerror", (error) => state.errors.push(error.message));
    await page.goto("/");
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    const submit = page.getByRole("button", { name: options.newCampaign || options.expiredCampaign ? /^(Pay & )?Promote 210 sats$/ : /^(Pay & )?Boost 210 sats$/ });
    if ((options.authorUnavailable && !(options.newCampaign && options.authorUnavailable === "no_address")) || (options.authorMinSats ?? 0) > 42) await expect(submit).toBeDisabled();
    else await expect(submit).toBeEnabled();
    return state;
}
async function backToForm(page: Page) {
    const back = page.getByRole("button", { name: /^< Back to / });
    while (await back.isVisible()) await back.click();
    const promotion = page.getByRole("tab", { name: "Promotion", exact: true });
    if (await promotion.isVisible() && await promotion.getAttribute("aria-selected") === "false") await promotion.click();
}
async function openPaymentOptions(page: Page) {
    const tab = page.getByRole("tab", { name: /^Payment options/ });
    if (await tab.isVisible()) await tab.click();
    else await page.getByRole("button", { name: "Payment options >", exact: true }).click();
}
async function openConnections(page: Page, section: "wallet" | "signer") {
    await backToForm(page);
    const publicZap = page.getByText(/^Public author zap( on)?$/);
    if (section === "signer" && await publicZap.isVisible()) await openSupport(page);
    else await openPaymentOptions(page);
    await page.getByRole("dialog").getByRole("button", { name: section === "wallet" ? /^(Connect wallet to pay here|Payment wallet settings)/ : /^(Connect Nostr for a public zap|Nostr signer settings)/ }).click();
}
async function openSupport(page: Page) {
    await backToForm(page);
    const disclosure = page.getByRole("region", { name: "Payment split" }).locator("details");
    if (await disclosure.isVisible() && !await disclosure.evaluate((element) => (element as HTMLDetailsElement).open)) {
        await disclosure.locator("summary").click();
    }
}
async function setAuthorShare(page: Page, share: number) {
    const slider = page.getByRole("slider", { name: "Holoboard share in percent" });
    await slider.focus(); await page.keyboard.press("End");
    for (let index = 0; index < share; index++) await page.keyboard.press("ArrowLeft");
    await expect(slider).toHaveValue(String(100 - share));
}
async function prepareInvoices(page: Page) {
    await backToForm(page);
    const manual = page.getByRole("button", { name: "Prepare invoices only", exact: true });
    if (!await manual.isVisible() && await page.getByRole("button", { name: /^Pay & Boost / }).isVisible()) await openPaymentOptions(page);
    if (await manual.isVisible()) await manual.click();
    else await page.getByRole("button", { name: /^(Boost|Promote) 210 sats$/ }).click();
}
async function connectNwc(page: Page) {
    await openConnections(page, "wallet");
    await page.getByLabel("NWC connection string").fill(walletUri);
    await page.getByRole("button", { name: "Connect NWC wallet", exact: true }).click();
    await expect(page.getByText("Connected: Test NWC wallet.", { exact: false })).toBeVisible();
}

async function savedPayment(page: Page) {
    return page.evaluate(() => {
        const key = sessionStorage.getItem("holoboard-last-payment");
        if (!key) throw new Error("Expected an unfinished payment");
        return JSON.parse(sessionStorage.getItem(key)!) as {
            board: Record<string, unknown>; boardAttempt?: Record<string, unknown>;
            author?: { amount_sats: number; author: string };
            authorAttempt?: { state: string; walletId: string; preimage?: string };
            promotionPaid: boolean; tipStatus: string; publicZap?: boolean;
        };
    });
}

async function connectTestExtension(page: Page) {
    const button = page.getByRole("button", { name: "Connect browser extension", exact: true });
    if (!await button.isVisible()) await openConnections(page, "signer");
    await button.click();
    await expect(page.getByText("Connected extension:", { exact: false })).toBeVisible();
}

async function disconnectTestSigner(page: Page) {
    const button = page.getByRole("button", { name: "Disconnect signer", exact: true });
    if (!await button.isVisible()) await openConnections(page, "signer");
    await button.click();
    await backToForm(page);
}

test("mock invoices are explained without sending NWC payments or lookup requests", async ({ context, page }) => {
    const state = await setup(context, page, { mockInvoice: true, authorShare: 20 });
    await connectNwc(page);
    await backToForm(page);
    await page.getByRole("button", { name: "Pay & Boost 210 sats", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("This preview uses test invoices");
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy invoice", exact: true })).toHaveCount(0);
    expect(state.boardRequests).toHaveLength(1);
    expect(state.methods).not.toContain("pay_invoice");
    expect(state.methods).not.toContain("lookup_invoice");
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0);
});

test("reopening ignores a saved visibility-only mock invoice with a failed wallet attempt", async ({ context, page }) => {
    const state = await setup(context, page, { authorShare: 0 });
    await prepareInvoices(page);
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toBeVisible();
    await page.evaluate(() => {
        const key = sessionStorage.getItem("holoboard-last-payment")!;
        const payment = JSON.parse(sessionStorage.getItem(key)!);
        payment.board.invoice = "lnbc210...mock_invoice";
        payment.boardAttempt = { state: "uncertain", walletId: "old-wallet" };
        sessionStorage.setItem(key, JSON.stringify(payment));
    });
    await page.reload();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveCount(0);
    await prepareInvoices(page);
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", "lightning:lnbc-visibility");
    expect(state.boardRequests).toHaveLength(2);
    expect(state.boardCharges).toBe(0);
});

test("a saved mock visibility invoice preserves an uncertain real author payment", async ({ context, page }) => {
    const state = await setup(context, page);
    await connectNwc(page);
    await prepareInvoices(page);
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveCount(2);
    await page.evaluate(() => {
        const key = sessionStorage.getItem("holoboard-last-payment")!;
        const payment = JSON.parse(sessionStorage.getItem(key)!);
        payment.board.invoice = "lnbc168...mock_invoice";
        payment.boardAttempt = { state: "uncertain", walletId: "old-wallet" };
        payment.authorAttempt = { state: "uncertain", walletId: "old-wallet" };
        sessionStorage.setItem(key, JSON.stringify(payment));
    });
    await page.reload();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await expect(page.getByRole("alert")).toContainText("The saved author invoice is separate");
    await expect(page.getByRole("button", { name: "Pay remaining parts with NWC wallet", exact: true })).toBeDisabled();
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", "lightning:lnbc-author");
    await expect(page.getByText("The author payment status is uncertain.", { exact: false })).toBeVisible();
    expect((await savedPayment(page)).authorAttempt?.state).toBe("uncertain");
    expect(state.boardRequests).toHaveLength(1);
    expect(state.methods).not.toContain("pay_invoice");
    expect(state.methods).not.toContain("lookup_invoice");
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0);
});

test("blocked browser storage preserves anonymous invoices when the form reopens", async ({ context, page }) => {
    const state = await setup(context, page, { blockStorage: true, authorShare: 0 });
    await prepareInvoices(page);
    await expect(page.getByText("This browser cannot save the payment for a refresh.", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", "lightning:lnbc-visibility");
    await expect(page.getByRole("button", { name: "Copy invoice", exact: true })).toBeVisible();
    await page.getByText("Show QR code", { exact: true }).click();
    await expect(page.getByRole("img", { name: "Holoboard visibility invoice QR code" })).toBeVisible();
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", "lightning:lnbc-visibility");
    expect(state.boardRequests).toHaveLength(1);
    await page.reload();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveCount(0);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0);
    expect(state.boardRequests).toHaveLength(1); expect(state.errors).toEqual([]);
});

test("blocked storage keeps confirmed and uncertain wallet parts across form reopening", async ({ context, page }) => {
    const state = await setup(context, page, { blockStorage: true, failAuthor: true });
    await connectNwc(page);
    await prepareInvoices(page);
    await page.getByRole("button", { name: "Pay remaining parts with NWC wallet" }).click();
    await expect(page.getByText("Added 168 sats to visibility.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "I checked my wallet: author support was not paid", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Pay remaining parts with NWC wallet" })).toBeEnabled();
    await page.getByRole("button", { name: "Pay remaining parts with NWC wallet" }).click();
    await expect(page.getByText("Author support: 42 sats, payment verified.", { exact: true })).toBeVisible();
    expect(state.methods).toContain("lookup_invoice");
    expect(state.boardCharges).toBe(1); expect(state.authorCharges).toBe(1); expect(state.authorAttempts).toBe(2);
    expect(state.boardRequests).toHaveLength(1); expect(state.authorRequests).toHaveLength(1); expect(state.errors).toEqual([]);
});

for (const scenario of ["new missing address", "new wallet outage", "existing missing address"] as const) test(`author availability allocation: ${scenario}`, async ({ context, page }) => {
    const newCampaign = scenario.startsWith("new");
    const state = await setup(context, page, { newCampaign, authorUnavailable: scenario === "new wallet outage" ? "unavailable" : "no_address" });
    await openSupport(page);
    const support = page.getByRole("slider", { name: "Holoboard share in percent" });
    if (scenario === "new missing address") await expect(support).toHaveValue("100");
    else {
        await expect(support).toHaveValue("80");
        await backToForm(page);
        await page.getByRole("button", { name: "Choose visibility only", exact: true }).click();
    }
    await backToForm(page);
    const submit = page.getByRole("button", { name: newCampaign ? "Promote 210 sats" : "Boost 210 sats", exact: true });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveCount(1);
    expect(state.boardRequests[0].amount_sats).toBe(210);
    expect(state.boardRequests[0].author_share).toBe(0);
    expect(state.authorRequests).toHaveLength(0); expect(state.boardCharges).toBe(0); expect(state.errors).toEqual([]);
});

for (const supportAuthor of [false, true]) test(`legacy campaign defaults to visibility only and permits author opt-in: ${supportAuthor}`, async ({ context, page }) => {
    const state = await setup(context, page, { authorShare: 0 });
    await openSupport(page);
    const support = page.getByRole("slider", { name: "Holoboard share in percent" });
    await expect(support).toHaveValue("100");
    await expect(page.getByRole("region", { name: "Payment split" }).locator('[aria-label="Holoboard visibility"]').getByText("210 sats", { exact: true })).toBeVisible();
    if (supportAuthor) {
        await setAuthorShare(page, 20);
        await expect(page.getByRole("region", { name: "Payment split" }).locator('[aria-label="Holoboard visibility"]').getByText("168 sats", { exact: true })).toBeVisible();
    }
    await prepareInvoices(page);
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveCount(supportAuthor ? 2 : 1);
    await expect(page.getByRole("button", { name: "Copy invoice", exact: true })).toHaveCount(supportAuthor ? 2 : 1);
    await page.getByText("Show QR code", { exact: true }).first().click();
    await expect(page.getByRole("img", { name: "Holoboard visibility invoice QR code" })).toBeVisible();
    expect(state.boardRequests[0].amount_sats).toBe(supportAuthor ? 168 : 210);
    expect(state.boardRequests[0].author_share).toBe(supportAuthor ? 20 : 0);
    expect(state.authorRequests).toHaveLength(supportAuthor ? 1 : 0);
    if (supportAuthor) {
        expect(state.authorRequests[0].amount_sats).toBe(42);
        expect(state.authorRequests[0]).not.toHaveProperty("zap_request");
    }
    expect(state.boardCharges).toBe(0);
    expect(state.authorCharges).toBe(0);
    expect(state.signerMethods).toEqual([]);
    expect(state.errors).toEqual([]);
});

test("anonymous single-invoice payment and restoring the campaign split", async ({ context, page }) => {
    const state = await setup(context, page);
    await openSupport(page);
    const slider = page.getByRole("slider", { name: "Holoboard share in percent" });
    await setAuthorShare(page, 35);
    await slider.press("End");
    await expect(page.getByRole("region", { name: "Payment split" }).locator('[aria-label="Holoboard visibility"]').getByText("210 sats", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Use campaign split", exact: true }).click();
    await expect(slider).toHaveValue("80");
    await openSupport(page);
    await slider.focus(); await slider.press("End");
    await prepareInvoices(page);
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", "lightning:lnbc-visibility");
    await expect(page.getByRole("button", { name: "Copy invoice", exact: true })).toBeVisible();
    await page.getByText("Show QR code", { exact: true }).click();
    await expect(page.getByRole("img", { name: "Holoboard visibility invoice QR code" })).toBeVisible();
    expect(state.authorRequests).toHaveLength(0);
    expect(state.boardRequests[0].amount_sats).toBe(210);
    expect(state.boardCharges).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(state.errors).toEqual([]);
});
for (const encryption of ["nip44_v2", "nip04"] as const) test(`NWC ${encryption} pays both recipients without requiring a signer`, async ({ context, page }) => {
    const state = await setup(context, page, { encryption });
    await connectNwc(page);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0);
    await prepareInvoices(page);
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveCount(2);
    await page.getByRole("button", { name: "Pay remaining parts with NWC wallet" }).click();
    await expect(page.getByText("Author support: 42 sats, payment verified.", { exact: true })).toBeVisible();
    await expect(page.getByText("Added 168 sats to visibility.", { exact: true })).toBeVisible();
    expect(state.boardCharges).toBe(1); expect(state.authorCharges).toBe(1);
    expect(state.errors).toEqual([]);
});
test("NWC recovers a failed author payment after reload without paying visibility twice", async ({ context, page }) => {
    const state = await setup(context, page, { failAuthor: true });
    await connectNwc(page);
    await prepareInvoices(page);
    await page.getByRole("button", { name: "Pay remaining parts with NWC wallet" }).click();
    await expect(page.getByText("Added 168 sats to visibility.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "I checked my wallet: author support was not paid", exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Pay remaining parts with NWC wallet" })).toBeEnabled();
    await page.getByRole("button", { name: "Pay remaining parts with NWC wallet" }).click();
    await expect(page.getByText("Author support: 42 sats, payment verified.", { exact: true })).toBeVisible();
    expect(state.methods).toContain("lookup_invoice");
    expect(state.boardCharges).toBe(1); expect(state.authorCharges).toBe(1); expect(state.authorAttempts).toBe(2);
    expect(state.boardRequests).toHaveLength(1); expect(state.authorRequests).toHaveLength(1);
    expect(state.errors).toEqual([]);
});
test("NWC recovers a paid author invoice after a lost response", async ({ context, page }) => {
    const state = await setup(context, page, { loseAuthorResponse: true });
    await connectNwc(page);
    await prepareInvoices(page);
    await page.getByRole("button", { name: "Pay remaining parts with NWC wallet" }).click();
    await expect.poll(() => state.authorCharges).toBe(1);
    await page.reload();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Pay remaining parts with NWC wallet" })).toBeEnabled();
    await page.getByRole("button", { name: "Pay remaining parts with NWC wallet" }).click();
    await expect(page.getByText("Author support: 42 sats, payment verified.", { exact: true })).toBeVisible();
    expect(state.methods).toContain("lookup_invoice");
    expect(state.boardCharges).toBe(1); expect(state.authorCharges).toBe(1); expect(state.authorAttempts).toBe(1);
    expect(state.errors).toEqual([]);
});
test("Amber connection signs a public author zap and restores after reload", async ({ context, page }) => {
    const state = await setup(context, page);
    await openConnections(page, "signer");
    await page.getByRole("button", { name: "Connect Amber / remote signer", exact: true }).click();
    await expect(page.getByText("Connected remote signer:", { exact: false })).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await openSupport(page);
    await page.getByRole("checkbox", { name: "Send author support as a public zap", exact: false }).check();
    await prepareInvoices(page);
    await expect(page.getByRole("heading", { name: "Support the original author: 42 sats" })).toBeVisible();
    expect(state.signerMethods).toContain("get_public_key"); expect(state.signerMethods).toContain("sign_event");
    expect(state.authorRequests[0]).toHaveProperty("zap_request");
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0);
    expect(state.errors).toEqual([]);
});
test("browser extension connects explicitly and remains optional for invoice payments", async ({ context, page }) => {
    const state = await setup(context, page, { extension: true });
    await openConnections(page, "signer");
    await page.getByRole("button", { name: "Connect browser extension", exact: true }).click();
    await expect(page.getByText("Connected extension:", { exact: false })).toBeVisible();
    await openSupport(page);
    await page.getByRole("checkbox", { name: "Send author support as a public zap", exact: false }).check();
    await prepareInvoices(page);
    await expect(page.getByRole("heading", { name: "Support the original author: 42 sats" })).toBeVisible();
    expect(state.authorRequests[0]).toHaveProperty("zap_request");
    expect(state.boardCharges).toBe(0);
    expect(state.errors).toEqual([]);
});
test("failed author invoice requires reviewing visibility-only allocation", async ({ context, page }) => {
    const state = await setup(context, page, { failAuthorInvoice: true });
    await prepareInvoices(page);
    await expect(page.getByRole("alert")).toContainText("Author invoice provider unavailable");
    expect(state.boardRequests).toHaveLength(0);
    await page.getByRole("button", { name: "Choose visibility only", exact: true }).click();
    expect(state.boardRequests).toHaveLength(0);
    await expect(page.getByRole("region", { name: "Payment split" }).locator('[aria-label="Holoboard visibility"]').getByText("210 sats", { exact: true })).toBeVisible();
    await prepareInvoices(page);
    await expect(page.getByRole("heading", { name: "Holoboard visibility: 210 sats" })).toBeVisible();
    expect(state.boardRequests[0].amount_sats).toBe(210);
    expect(state.errors).toEqual([]);
});

test("signer QR preserves the connection token and can be cancelled", async ({ context, page }) => {
    const state = await setup(context, page, { deferSigner: true });
    await openConnections(page, "signer");
    await page.getByRole("button", { name: "Connect Amber / remote signer", exact: true }).click();
    await expect(page.getByRole("link", { name: "Open Amber / signer" })).toBeVisible();
    const uri = await page.getByRole("link", { name: "Open Amber / signer" }).getAttribute("href");
    await page.getByText("Show signer QR code", { exact: true }).click();
    const qr = page.getByRole("img", { name: "Signer connection QR code" });
    await expect(qr).toBeVisible();
    const png = PNG.sync.read(await qr.screenshot());
    expect(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data).toBe(uri);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.getByRole("button", { name: "Cancel signer connection", exact: true }).click();
    await expect(page.getByRole("button", { name: "Connect Amber / remote signer", exact: true })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("holoboard-signer"))).toBeNull();
    expect(state.boardCharges).toBe(0); expect(state.errors).toEqual([]);
});

test("disconnecting NWC leaves anonymous invoice payment available", async ({ context, page }) => {
    const state = await setup(context, page);
    await connectNwc(page);
    await page.getByRole("button", { name: "Disconnect wallet", exact: true }).click();
    expect(await page.evaluate(() => sessionStorage.getItem("holoboard-nwc"))).toBeNull();
    await openSupport(page);
    await setAuthorShare(page, 0);
    await prepareInvoices(page);
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", "lightning:lnbc-visibility");
    await expect(page.getByRole("button", { name: "Copy invoice", exact: true })).toBeVisible();
    expect(state.boardCharges).toBe(0); expect(state.authorRequests).toHaveLength(0); expect(state.errors).toEqual([]);
});

test("disconnecting signer permits ordinary author support", async ({ context, page }) => {
    const state = await setup(context, page, { extension: true });
    await openConnections(page, "signer");
    await page.getByRole("button", { name: "Connect browser extension", exact: true }).click();
    await expect(page.getByText("Connected extension:", { exact: false })).toBeVisible();
    await openSupport(page);
    await page.getByRole("checkbox", { name: "Send author support as a public zap", exact: false }).check();
    await disconnectTestSigner(page);
    await openSupport(page);
    await expect(page.getByRole("checkbox", { name: "Send author support as a public zap", exact: false })).toHaveCount(0);
    await prepareInvoices(page);
    await expect(page.getByRole("heading", { name: "Support the original author: 42 sats" })).toBeVisible();
    expect(state.authorRequests[0]).not.toHaveProperty("zap_request");
    expect(state.boardRequests[0].amount_sats).toBe(168);
    expect(state.errors).toEqual([]);
});

for (const wallet of ["NWC", "WebLN"] as const) {
    for (const expired of ["author", "visibility"] as const) test(`${wallet} pays the valid recipient when ${expired} invoice expired`, async ({ context, page }) => {
        const state = await setup(context, page, { webln: wallet === "WebLN", authorExpiresIn: expired === "author" ? -1 : 3600, boardExpiresIn: expired === "visibility" ? -1 : 3600 });
        if (wallet === "NWC") await connectNwc(page);
        await prepareInvoices(page);
        const pay = page.getByRole("button", { name: wallet === "NWC" ? "Pay remaining parts with NWC wallet" : "Pay remaining parts with browser wallet" });
        await expect(pay).toBeEnabled();
        await pay.click();
        if (expired === "author") {
            await expect(page.getByText("Added 168 sats to visibility.", { exact: true })).toBeVisible();
            await expect(page.getByText("The author invoice expired.", { exact: false })).toBeVisible();
            expect(state.boardCharges).toBe(1); expect(state.authorCharges).toBe(0); expect(state.authorAttempts).toBe(0);
        } else {
            await expect(page.getByText("Author support: 42 sats, payment verified.", { exact: true })).toBeVisible();
            expect(state.authorCharges).toBe(1); expect(state.boardCharges).toBe(0); expect(state.boardPaid).toBe(false);
        }
        await expect(pay).toBeDisabled();
        expect(state.errors).toEqual([]);
    });
}

test("NWC recovers a lost author response after invoice expiry and reload", async ({ context, page }) => {
    const state = await setup(context, page, { loseAuthorResponse: true });
    await page.clock.install();
    await connectNwc(page);
    await prepareInvoices(page);
    await page.getByRole("button", { name: "Pay remaining parts with NWC wallet" }).click();
    await expect.poll(() => state.authorCharges).toBe(1);
    await page.clock.fastForward(12001);
    await expect(page.getByRole("button", { name: "I checked my wallet: author support was not paid", exact: true })).toBeVisible();
    // Expire the invoice without also firing the board refresh just before
    // navigation, which leaves an intercepted WebKit request in flight.
    await page.clock.setSystemTime(new Date((await page.evaluate(() => Date.now())) + 3601000));
    await page.clock.runFor(1001);
    await expect(page.getByText("The author invoice expired.", { exact: false })).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await expect(page.getByText("The author invoice expired.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Replace author invoice after checking wallet" })).toBeDisabled();
    const before = await savedPayment(page);
    await page.getByRole("button", { name: "Pay remaining parts with NWC wallet" }).click();
    await expect(page.getByText("Author support: 42 sats, payment verified.", { exact: true })).toBeVisible();
    expect(state.methods).toContain("lookup_invoice");
    expect(state.boardCharges).toBe(1); expect(state.authorCharges).toBe(1); expect(state.authorAttempts).toBe(1);
    expect(state.authorRequests).toHaveLength(1); expect(state.errors).toEqual([]);
    const confirmed = await savedPayment(page);
    expect(confirmed.tipStatus).toBe("confirmed"); expect(confirmed.authorAttempt?.state).toBe("submitted");
    expect(confirmed.promotionPaid).toBe(true); expect(confirmed.boardAttempt).toEqual(before.boardAttempt);
    expect(confirmed.board).toEqual(before.board);
});

for (const lookupState of ["pending", "unknown"] as const) test(`NWC lookup ${lookupState} keeps an expired author attempt protected`, async ({ context, page }) => {
    const state = await setup(context, page, { failAuthor: true, lookupState });
    await page.clock.install();
    await connectNwc(page);
    await prepareInvoices(page);
    await page.getByRole("button", { name: "Pay remaining parts with NWC wallet" }).click();
    await expect(page.getByRole("button", { name: "I checked my wallet: author support was not paid", exact: true })).toBeVisible();
    await page.clock.fastForward(3601000);
    await expect(page.getByText("The author invoice expired.", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Pay remaining parts with NWC wallet" }).click();
    await expect(page.getByRole("alert")).toContainText("not confirmed that this payment failed");
    await expect(page.getByRole("button", { name: "Replace author invoice after checking wallet" })).toBeDisabled();
    expect(state.methods).toContain("lookup_invoice"); expect(state.boardCharges).toBe(1);
    expect(state.authorAttempts).toBe(1); expect(state.authorCharges).toBe(0); expect(state.authorRequests).toHaveLength(1);
    const saved = await savedPayment(page);
    expect(saved.authorAttempt?.state).toBe("uncertain"); expect(saved.promotionPaid).toBe(true);
    await page.reload();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Replace author invoice after checking wallet" })).toBeDisabled();
    expect((await savedPayment(page)).authorAttempt).toEqual(saved.authorAttempt);
    expect(state.errors).toEqual([]);
});

test("disconnected signer permits replacing an expired public zap with ordinary author support", async ({ context, page }) => {
    const state = await setup(context, page, { extension: true, authorExpiresIn: -1 });
    await openConnections(page, "signer");
    await page.getByRole("button", { name: "Connect browser extension", exact: true }).click();
    await expect(page.getByText("Connected extension:", { exact: false })).toBeVisible();
    await openSupport(page);
    await page.getByRole("checkbox", { name: "Send author support as a public zap", exact: false }).check();
    await prepareInvoices(page);
    await expect(page.getByText("The author invoice expired.", { exact: false })).toBeVisible();
    await disconnectTestSigner(page);
    await page.getByRole("button", { name: "Replace author invoice after checking wallet" }).click();
    await expect.poll(() => state.authorRequests.length).toBe(2);
    expect(state.authorRequests[0]).toHaveProperty("zap_request");
    expect(state.authorRequests[1]).not.toHaveProperty("zap_request");
    expect(state.authorRequests[1].amount_sats).toBe(42); expect(state.boardRequests).toHaveLength(1);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
});

test("anonymous split invoices remain accessible without wallet or signer", async ({ context, page }) => {
    const state = await setup(context, page);
    await prepareInvoices(page);
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Copy invoice", exact: true })).toHaveCount(2);
    const toggles = page.getByText("Show QR code", { exact: true });
    await toggles.nth(0).click(); await toggles.nth(1).click();
    await expect(page.getByRole("img", { name: "Support the original author invoice QR code" })).toBeVisible();
    await expect(page.getByRole("img", { name: "Holoboard visibility invoice QR code" })).toBeVisible();
    expect(state.authorRequests[0]).not.toHaveProperty("zap_request");
    expect(state.boardRequests[0].amount_sats).toBe(168); expect(state.authorRequests[0].amount_sats).toBe(42);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
});

test("failed expired author attempt permits replacement after NWC lookup", async ({ context, page }) => {
    const options: Options = { failAuthor: true };
    const state = await setup(context, page, options);
    await page.clock.install();
    await connectNwc(page);
    await prepareInvoices(page);
    await page.getByRole("button", { name: "Pay remaining parts with NWC wallet" }).click();
    await expect(page.getByText("Added 168 sats to visibility.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "I checked my wallet: author support was not paid", exact: true })).toBeVisible();
    await page.clock.fastForward(3601000);
    await expect(page.getByText("The author invoice expired.", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Pay remaining parts with NWC wallet" }).click();
    await expect(page.getByRole("alert")).toContainText("invoice expired");
    expect(state.methods).toContain("lookup_invoice");
    expect(state.authorCharges).toBe(0);
    const saved = await savedPayment(page);
    expect(saved.authorAttempt?.state).toBe("unpaid");
    expect(saved.promotionPaid).toBe(true); expect(saved.boardAttempt?.state).toBe("submitted");
    await page.reload();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    const replacement = page.getByRole("button", { name: "Replace author invoice after checking wallet" });
    await expect(replacement).toBeEnabled();
    options.authorExpiresIn = 7200;
    await replacement.click();
    await expect(page.getByRole("heading", { name: "Support the original author: 42 sats" })).toBeVisible();
    const replaced = await savedPayment(page);
    expect(replaced.board).toEqual(saved.board); expect(replaced.boardAttempt).toEqual(saved.boardAttempt);
    expect(replaced.promotionPaid).toBe(true); expect(replaced.tipStatus).toBe(saved.tipStatus);
    expect(replaced.authorAttempt).toBeUndefined();
    expect(replaced.author?.amount_sats).toBe(saved.author?.amount_sats);
    expect(replaced.author?.author).toBe(saved.author?.author);
    expect(state.authorRequests).toHaveLength(2); expect(state.boardRequests).toHaveLength(1);
    expect(state.authorAttempts).toBe(1); expect(state.boardCharges).toBe(1); expect(state.authorCharges).toBe(0);
    expect(state.errors).toEqual([]);
});

for (const change of ["unchanged", "other account", "reconnected", "extension reload", "remote reload"] as const) {
    test(`author replacement public zap consent with signer ${change}`, async ({ context, page }) => {
        const options: Options = { extension: change !== "remote reload", authorExpiresIn: -1 };
        const state = await setup(context, page, options);
        if (change === "other account") await connectNwc(page);
        if (change === "remote reload") {
            await openConnections(page, "signer");
            await page.getByRole("button", { name: "Connect Amber / remote signer", exact: true }).click();
            await expect(page.getByText("Connected remote signer:", { exact: false })).toBeVisible();
        } else await connectTestExtension(page);
        await openSupport(page);
        await page.getByRole("checkbox", { name: "Send author support as a public zap", exact: false }).check();
        await prepareInvoices(page);
        await expect(page.getByText("The author invoice expired.", { exact: false })).toBeVisible();
        expect(state.authorRequests[0]).toHaveProperty("zap_request");
        if (change === "other account") {
            await page.getByRole("button", { name: "Pay remaining parts with NWC wallet" }).click();
            await expect(page.getByText("Added 168 sats to visibility.", { exact: true })).toBeVisible();
        }
        const before = await savedPayment(page);
        if (change === "other account" || change === "reconnected") {
            await disconnectTestSigner(page);
            if (change === "other account") {
                const otherKey = generateSecretKey();
                state.expectedSignerPubkey = getPublicKey(otherKey);
                await page.evaluate(({ secret, pubkey }) => {
                    const target = window as unknown as { nostr: unknown; testSignEvent(template: unknown, key: number[]): Promise<unknown> };
                    target.nostr = { getPublicKey: async () => pubkey, signEvent: (template: unknown) => target.testSignEvent(template, secret) };
                }, { secret: Array.from(otherKey), pubkey: state.expectedSignerPubkey });
            }
            await connectTestExtension(page);
        } else if (change === "extension reload" || change === "remote reload") {
            await page.reload();
            await page.getByRole("button", { name: "Boost", exact: true }).first().click();
            if (change === "extension reload") await connectTestExtension(page);
            else {
                await openConnections(page, "signer");
                await expect(page.getByText("Connected remote signer:", { exact: false })).toBeVisible();
            }
        }
        await backToForm(page);
        if (change !== "unchanged") {
            await expect(page.getByText("Public zap consent ended with the previous signer session.", { exact: false })).toBeVisible();
        }
        const signaturesBefore = state.signerMethods.filter((method) => method.endsWith("sign_event")).length;
        options.authorExpiresIn = 3600;
        await page.getByRole("button", { name: "Replace author invoice after checking wallet" }).click();
        await expect(page.getByRole("heading", { name: "Support the original author: 42 sats" })).toBeVisible();
        expect(state.authorRequests).toHaveLength(2);
        if (change === "unchanged") expect(state.authorRequests[1]).toHaveProperty("zap_request.pubkey", getPublicKey(userKey));
        else expect(state.authorRequests[1]).not.toHaveProperty("zap_request");
        expect(state.signerMethods.filter((method) => method.endsWith("sign_event")).length).toBe(signaturesBefore+(change === "unchanged" ? 1 : 0));
        const after = await savedPayment(page);
        expect(after.publicZap).toBe(change === "unchanged");
        expect(after.board).toEqual(before.board); expect(after.boardAttempt).toEqual(before.boardAttempt);
        expect(after.author?.amount_sats).toBe(before.author?.amount_sats); expect(after.author?.author).toBe(before.author?.author);
        expect(after.promotionPaid).toBe(before.promotionPaid); expect(after.tipStatus).toBe(before.tipStatus);
        expect(state.boardRequests).toHaveLength(1);
        expect(state.boardCharges).toBe(change === "other account" ? 1 : 0); expect(state.authorCharges).toBe(0);
        expect(state.errors).toEqual([]);
    });
}

for (const viewport of [{ width: 320, height: 640 }, { width: 360, height: 640 }, { width: 390, height: 740 }, { width: 1280, height: 720 }]) {
    test(`quick boost fits without scrolling at ${viewport.width}x${viewport.height}`, async ({ context, page }) => {
        await page.setViewportSize(viewport);
        const content = `nostr:${npubEncode(note.pubkey)} nostr:${neventEncode({ id: note.id })} http://127.0.0.1:3334/preview-image.png\n\n${"A long original paragraph.\n\n".repeat(120)}`;
        const state = await setup(context, page, { rank: 25, targets: [{ rank: 21, weight: 400 }], noteContent: content });
        const article = page.getByRole("article", { name: "Original note" });
        await expect(article).toBeVisible();
        await expect(article.getByRole("link", { name: "Open note", exact: true })).toHaveAttribute("href", /^https:\/\/njump\.me\/note1/);
        await expect(article.getByRole("img", { name: "Image from the original note", exact: true })).toBeVisible();
        await expect.poll(() => article.getByRole("img", { name: "Image from the original note", exact: true }).evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(32);
        await expect(article.locator('a[href^="https://njump.me/nevent1"]')).toHaveCount(1);
        const preview = await article.locator(".line-clamp-2").boundingBox();
        expect(preview!.height).toBeLessThanOrEqual(47);
        const body = page.getByRole("dialog").locator("[data-modal-body]");
        const assertFits = async () => {
            expect(await body.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
            expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
            const bounds = await page.getByRole("button", { name: /^Boost \d+ sats$/ }).boundingBox();
            expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
        };
        const preset = await page.getByRole("button", { name: "21k", exact: true }).boundingBox();
        const custom = await page.getByRole("button", { name: "Custom", exact: true }).boundingBox();
        expect(custom!.y).toBeCloseTo(preset!.y, 0);
        expect(custom!.x).toBeGreaterThanOrEqual(preset!.x + preset!.width);
        await assertFits();
        await page.screenshot({ path: test.info().outputPath("quick-boost-amount.png") });
        await expect(page.getByText("2 recipient invoices", { exact: true })).toHaveCount(0);
        await expect(page.getByRole("slider", { name: "Holoboard share in percent" })).toHaveAttribute("aria-valuetext", "Holoboard 80%, 168 sats; author 20%, 42 sats");
        await page.getByRole("button", { name: "Target position", exact: true }).click();
        await assertFits();
        await page.getByRole("button", { name: /Reach rank 21, estimated total/ }).click();
        await expect(page.getByRole("button", { name: "Boost 251 sats", exact: true })).toBeEnabled();
        await page.screenshot({ path: test.info().outputPath("quick-boost-position.png") });
        expect(state.boardRequests).toHaveLength(0); expect(state.authorRequests).toHaveLength(0); expect(state.errors).toEqual([]);
    });
}

for (const viewport of [{ width: 320, height: 640 }, { width: 1280, height: 720 }]) {
    test(`connected-wallet boost fits and preserves manual invoices at ${viewport.width}x${viewport.height}`, async ({ context, page }) => {
        await page.setViewportSize(viewport);
        const state = await setup(context, page, { webln: true, noteContent: `http://127.0.0.1:3334/preview-image.png ${"Original paragraph. ".repeat(120)}` });
        const body = page.getByRole("dialog").locator("[data-modal-body]");
        expect(await body.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
        await expect(page.getByRole("button", { name: "Pay & Boost 210 sats", exact: true })).toBeEnabled();
        await expect(page.getByRole("button", { name: "Prepare invoices only", exact: true })).toHaveCount(0);
        await prepareInvoices(page);
        await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveCount(2);
        await expect(page.getByRole("button", { name: "Copy invoice", exact: true })).toHaveCount(2);
        expect(state.boardRequests[0]).toMatchObject({ amount_sats: 168, author_share: 20 });
        expect(state.authorRequests[0].amount_sats).toBe(42);
        expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
    });
}

test("promotion preview bounds images and keeps Nostr references clickable", async ({ context, page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    const image = "http://127.0.0.1:3334/preview-image.png";
    const content = `nostr:${npubEncode(note.pubkey)} nostr:${neventEncode({ id: note.id })} ${image}\n\n${"Original note text.\n\n".repeat(120)}`;
    const state = await setup(context, page, { newCampaign: true, noteContent: content });
    const article = page.getByRole("article", { name: "Original note" });
    const thumbnail = article.getByRole("img", { name: "Image from the original note", exact: true });
    await expect(thumbnail).toBeVisible();
    expect((await thumbnail.boundingBox())!.height).toBeLessThanOrEqual(80);
    await expect(article.locator('a[href^="https://njump.me/nevent1"]')).toHaveCount(1);
    await page.getByRole("button", { name: "Custom", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Custom total in sats" }).fill("500");
    await page.getByRole("button", { name: "Show full text", exact: true }).click();
    await expect(article.locator('[aria-label="Original note images"]')).toBeVisible();
    await expect(article.getByRole("link", { name: "Open original image", exact: true })).toHaveAttribute("href", image);
    const bounds = await page.getByRole("button", { name: "Promote 500 sats", exact: true }).boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(740);
    await page.getByRole("button", { name: "Show less", exact: true }).click();
    await page.getByRole("tab", { name: /^Payment options/ }).click();
    await page.getByRole("tab", { name: "Promotion", exact: true }).click();
    await expect(page.getByRole("spinbutton", { name: "Custom total in sats" })).toHaveValue("500");
    await expect(thumbnail).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(state.boardRequests).toHaveLength(0); expect(state.authorRequests).toHaveLength(0); expect(state.errors).toEqual([]);
});

test("image-only boost stays compact when its thumbnail is unavailable", async ({ context, page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    const state = await setup(context, page, { noteContent: "http://127.0.0.1:3334/preview-image.png?broken=1" });
    const article = page.getByRole("article", { name: "Original note" });
    await expect(article.getByText("IMG", { exact: true })).toBeVisible();
    await expect(article.getByText("[Image]", { exact: true })).toBeVisible();
    const thumbnail = await article.getByRole("link", { name: "Open original image", exact: true }).boundingBox();
    expect(thumbnail!.width).toBe(48); expect(thumbnail!.height).toBe(48);
    const body = page.getByRole("dialog").locator("[data-modal-body]");
    expect(await body.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    expect(state.boardRequests).toHaveLength(0); expect(state.authorRequests).toHaveLength(0); expect(state.errors).toEqual([]);
});

test("amount modes and inline split preserve a boost draft across contextual panels", async ({ context, page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    const state = await setup(context, page, { rank: 25, targets: [{ rank: 1, weight: 800 }, { rank: 2, weight: 600 }, { rank: 3, weight: 500 }, { rank: 21, weight: 400 }] });
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: /^(Wallet|Connect Nostr|Author support|Adjust|View appearance)$/ })).toHaveCount(0);
    const presetBounds = await dialog.getByRole("button", { name: "210", exact: true }).boundingBox();
    await page.getByRole("button", { name: "Target position", exact: true }).click();
    const positionButtons = dialog.getByRole("button", { name: /^Reach rank / });
    await expect(positionButtons).toHaveCount(4);
    await expect(positionButtons.first()).toHaveAccessibleName("Reach rank 21, estimated total 251 sats");
    const positionBounds = await positionButtons.first().boundingBox();
    expect(positionBounds!.width).toBeCloseTo(presetBounds!.width, 0);
    expect(positionBounds!.height).toBeCloseTo(presetBounds!.height, 0);
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Reach rank 21, estimated total 251 sats", exact: true }).click();
    await page.getByRole("button", { name: "Amount", exact: true }).click();
    await expect(page.getByRole("spinbutton", { name: "Custom total in sats" })).toHaveValue("251");
    await page.getByRole("button", { name: "Target position", exact: true }).click();
    await openSupport(page);
    await setAuthorShare(page, 50);
    await expect(page.getByRole("region", { name: "Payment split" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reach rank 21, estimated total 401 sats", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: "Boost 251 sats", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "How ranking works >", exact: true }).click();
    await expect(page.getByRole("heading", { name: "How ranking works", exact: true })).toBeFocused();
    await backToForm(page);
    await expect(page.getByRole("button", { name: "Target position", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("slider", { name: "Holoboard share in percent" })).toHaveValue("50");
    await openConnections(page, "wallet");
    await expect(page.getByLabel("NWC connection string")).toBeVisible();
    await backToForm(page);
    await expect(page.getByRole("button", { name: "Target position", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Reach rank 2, estimated total 801 sats", exact: true }).click();
    await page.getByRole("button", { name: "Use campaign split", exact: true }).click();
    await expect(page.getByRole("slider", { name: "Holoboard share in percent" })).toHaveValue("80");
    await expect(page.getByRole("button", { name: "Boost 801 sats", exact: true })).toBeEnabled();
    await setAuthorShare(page, 50);
    await openPaymentOptions(page);
    await backToForm(page);
    await page.screenshot({ path: test.info().outputPath("inline-split-position-320.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(state.boardRequests).toHaveLength(0); expect(state.authorRequests).toHaveLength(0);
    await page.getByRole("button", { name: "Boost 801 sats", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Holoboard visibility: 401 sats", exact: true })).toBeVisible();
    expect(state.boardRequests[0]).toMatchObject({ amount_sats: 401, author_share: 50 });
    expect(state.authorRequests[0].amount_sats).toBe(400);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
});

test("public author zap is reachable by keyboard without gating invoices", async ({ context, page }) => {
    const state = await setup(context, page, { extension: true });
    const slider = page.getByRole("slider", { name: "Holoboard share in percent" });
    const disclosure = page.getByRole("region", { name: "Payment split" }).locator("summary");
    await slider.focus(); await page.keyboard.press("Tab");
    await expect(disclosure).toBeFocused();
    await page.keyboard.press("Enter");
    const connect = page.getByRole("button", { name: "Connect Nostr for a public zap >", exact: true });
    await expect(connect).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(connect).toBeFocused();
    await page.keyboard.press("Enter");
    await connectTestExtension(page);
    await backToForm(page);
    await slider.focus(); await page.keyboard.press("Tab");
    await expect(disclosure).toBeFocused();
    await page.keyboard.press("Enter");
    await page.getByRole("checkbox", { name: "Send author support as a public zap", exact: false }).check();
    await expect(disclosure).toHaveText("Public author zap on");
    await prepareInvoices(page);
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveCount(2);
    expect(state.authorRequests[0]).toHaveProperty("zap_request");
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
});

test("split bar responds to pointer input and bills the displayed recipients", async ({ context, page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    const state = await setup(context, page);
    const slider = page.getByRole("slider", { name: "Holoboard share in percent" });
    await slider.scrollIntoViewIfNeeded();
    const bounds = await slider.boundingBox();
    await slider.click({ position: { x: bounds!.width / 4, y: bounds!.height / 2 } });
    const visibilityShare = Number(await slider.inputValue());
    expect(visibilityShare).toBeGreaterThanOrEqual(20);
    expect(visibilityShare).toBeLessThanOrEqual(30);
    const split = page.getByRole("region", { name: "Payment split" });
    const visibility = Number((await split.locator('[aria-label="Holoboard visibility"] strong').innerText()).split(" ")[0]);
    const author = Number((await split.locator('[aria-label="Author support"] strong').innerText()).split(" ")[0]);
    expect(visibility + author).toBe(210);
    await expect(slider).toHaveAttribute("aria-valuetext", `Holoboard ${visibilityShare}%, ${visibility} sats; author ${100 - visibilityShare}%, ${author} sats`);
    await page.getByRole("button", { name: "Boost 210 sats", exact: true }).click();
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveCount(2);
    expect(state.boardRequests[0]).toMatchObject({ amount_sats: visibility, author_share: 100 - visibilityShare });
    expect(state.authorRequests[0].amount_sats).toBe(author);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
});

test("boost payment options offer notifications without a settings list", async ({ context, page }) => {
    const state = await setup(context, page);
    await expect(page.getByRole("button", { name: /^(Customize >|Notifications|< Quick boost|Change split|Hide split)$/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^(View appearance|Appearance|Billboard \+)/ })).toHaveCount(0);
    await openPaymentOptions(page);
    await expect(page.getByRole("checkbox", { name: "Send me a confirmation DM", exact: true })).toBeVisible();
    await backToForm(page);
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    expect(state.boardRequests).toHaveLength(0); expect(state.errors).toEqual([]);
});

test("revived promotion offers appearance and contextual notification identity", async ({ context, page }) => {
    const state = await setup(context, page, { expiredCampaign: true, extension: true });
    await expect(page.getByRole("tab", { name: /^Billboard/ })).toBeVisible();
    await openSupport(page);
    await expect(page.getByRole("region", { name: "Payment split" })).toBeVisible();
    await page.getByRole("tab", { name: /^Billboard/ }).click();
    await page.getByRole("button", { name: "Billboard / +100 sats", exact: true }).click();
    await backToForm(page);
    await openPaymentOptions(page);
    await page.getByRole("checkbox", { name: "Send me a confirmation DM", exact: true }).check();
    await page.getByRole("button", { name: "Connect Nostr to use your npub >", exact: true }).click();
    await connectTestExtension(page);
    await page.getByRole("button", { name: "< Back to settings", exact: true }).click();
    await page.getByRole("button", { name: "Use connected Nostr identity", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Npub for confirmation", exact: true })).toHaveValue(note.pubkey);
    await backToForm(page);
    await expect(page.getByRole("button", { name: "Promote 310 sats", exact: true })).toBeEnabled();
    expect(state.boardRequests).toHaveLength(0); expect(state.authorRequests).toHaveLength(0);
    expect(state.signerMethods).not.toContain("extension:sign_event"); expect(state.errors).toEqual([]);
});

test("unavailable and unaffordable positions preserve the amount path", async ({ context, page }) => {
    const options: Options = { targets: [{ rank: 1, weight: 100000000 }] };
    const state = await setup(context, page, options);
    await page.getByRole("button", { name: "Target position", exact: true }).click();
    await expect(page.getByText("No higher target positions are available.", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Amount", exact: true }).click();
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    options.rank = 25;
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Target position", exact: true }).click();
    await expect(page.getByRole("button", { name: /Reach rank 1, estimated total/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    expect(state.boardRequests).toHaveLength(0); expect(state.authorRequests).toHaveLength(0); expect(state.errors).toEqual([]);
});

test("long original notes scroll while the promotion action stays visible", async ({ context, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = await setup(context, page, { noteContent: "A long original paragraph.\n\n".repeat(120) });
    await page.getByRole("button", { name: "Show full text", exact: true }).click();
    const body = page.getByRole("dialog").locator("[data-modal-body]");
    await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const bounds = await page.getByRole("button", { name: "Boost 210 sats", exact: true }).boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(state.errors).toEqual([]);
});

test("customization, contextual help and notifications preserve payment choices", async ({ context, page }) => {
    const state = await setup(context, page, { newCampaign: true });
    await page.getByRole("button", { name: "Custom", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Custom total in sats" }).fill("500");
    await openSupport(page);
    await setAuthorShare(page, 35);
    await backToForm(page);
    await page.getByRole("tab", { name: /^Billboard/ }).click();
    await page.getByRole("button", { name: "Billboard / +100 sats", exact: true }).click();
    await page.getByRole("button", { name: "Neon sign", exact: true }).click();
    await page.getByRole("combobox", { name: "Text size", exact: true }).selectOption("large");
    await backToForm(page);
    await page.getByRole("button", { name: "Target position", exact: true }).click();
    await expect(page.getByRole("button", { name: "Reach rank 1, estimated total 408 sats", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Promote 600 sats", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Amount", exact: true }).click();
    await openPaymentOptions(page);
    await page.getByRole("checkbox", { name: "Send me a confirmation DM", exact: true }).check();
    await page.getByRole("textbox", { name: "Npub for confirmation", exact: true }).fill(note.pubkey);
    await backToForm(page);
    await page.getByRole("dialog").getByRole("button", { name: "Help >", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Other ways to promote", exact: true })).toBeAttached();
    await expect(page.getByRole("button", { name: "Copy Holoboard pubkey", exact: true })).toBeAttached();
    await backToForm(page);
    await expect(page.getByRole("spinbutton", { name: "Custom total in sats" })).toHaveValue("500");
    await expect(page.getByText("Billboard +100 sats, included in the total.", { exact: true })).toBeVisible();
    await openPaymentOptions(page);
    await expect(page.getByRole("checkbox", { name: "Send me a confirmation DM", exact: true })).toBeChecked();
    await backToForm(page);
    await page.screenshot({ path: test.info().outputPath("promotion-editor.png") });
    await page.getByRole("tab", { name: /^Payment options/ }).click();
    await page.screenshot({ path: test.info().outputPath("promotion-payment-options.png") });
    await page.getByRole("button", { name: "Promote 600 sats", exact: true }).click();
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveCount(2);
    expect(state.boardRequests).toHaveLength(1);
    expect(state.boardRequests[0]).toMatchObject({ amount_sats: 325, author_share: 35, notify_pubkey: note.pubkey, billboard: { template: "neon", size: "large" } });
    expect(state.authorRequests[0].amount_sats).toBe(175);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
});

test("promotion tabs keep the draft and payment action accessible", async ({ context, page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    const state = await setup(context, page, { newCampaign: true });
    const tabs = page.getByRole("tablist", { name: "Promotion editor", exact: true });
    const promotion = tabs.getByRole("tab", { name: "Promotion", exact: true });
    const billboard = tabs.getByRole("tab", { name: /^Billboard/ });
    const options = tabs.getByRole("tab", { name: /^Payment options/ });
    await expect(promotion).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toHaveAccessibleName("Promotion");
    await page.getByRole("button", { name: "Custom", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Custom total in sats" }).fill("500");
    await setAuthorShare(page, 35);
    await promotion.focus();
    await page.keyboard.press("ArrowRight");
    await expect(billboard).toBeFocused();
    await expect(billboard).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Billboard / +100 sats", exact: true }).click();
    await page.getByRole("button", { name: "Neon sign", exact: true }).click();
    const body = page.getByRole("dialog").locator("[data-modal-body]");
    await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(tabs).toBeInViewport();
    await expect(page.getByRole("button", { name: "Promote 600 sats", exact: true })).toBeInViewport();
    await options.click();
    await expect(page.getByRole("region", { name: "Notifications", exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: "Send me a confirmation DM", exact: true }).check();
    await promotion.click();
    await page.getByRole("button", { name: "Promote 600 sats", exact: true }).click();
    await expect(options).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("alert")).toHaveText("Enter a valid npub for the confirmation DM.");
    expect(state.boardRequests).toHaveLength(0); expect(state.authorRequests).toHaveLength(0);
    await page.getByRole("textbox", { name: "Npub for confirmation", exact: true }).fill(note.pubkey);
    await options.focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("tabpanel")).toBeFocused();
    await options.focus();
    await page.keyboard.press("Home");
    await expect(promotion).toBeFocused();
    await expect(page.getByRole("spinbutton", { name: "Custom total in sats" })).toHaveValue("500");
    await expect(page.getByRole("slider", { name: "Holoboard share in percent" })).toHaveValue("65");
    await billboard.click();
    await expect(page.getByRole("button", { name: "Neon sign", exact: true })).toHaveAttribute("aria-pressed", "true");
    await options.click();
    await expect(page.getByRole("checkbox", { name: "Send me a confirmation DM", exact: true })).toBeChecked();
    await page.screenshot({ path: test.info().outputPath("promotion-tabs-320.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(state.boardRequests).toHaveLength(0); expect(state.authorRequests).toHaveLength(0);
    await page.getByRole("button", { name: "Promote 600 sats", exact: true }).click();
    await expect(tabs).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveCount(2);
    expect(state.boardRequests[0]).toMatchObject({ amount_sats: 325, author_share: 35, notify_pubkey: note.pubkey, billboard: { template: "neon" } });
    expect(state.authorRequests[0].amount_sats).toBe(175);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
});

test("author invoice limits are explained before a visibility-only choice", async ({ context, page }) => {
    const state = await setup(context, page, { authorMinSats: 100 });
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeDisabled();
    await expect(page.getByRole("alert")).toContainText("100 to 10000000 sats");
    expect(state.boardRequests).toHaveLength(0); expect(state.authorRequests).toHaveLength(0);
    await page.getByRole("button", { name: "Choose visibility only", exact: true }).click();
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    await expect(page.getByRole("slider", { name: "Holoboard share in percent" })).toHaveAttribute("aria-valuetext", "Holoboard 100%, 210 sats; author 0%, 0 sats");
    expect(state.boardRequests).toHaveLength(0); expect(state.authorRequests).toHaveLength(0);
});

for (const wallet of ["NWC", "WebLN"] as const) test(`${wallet} quick boost pays both invoices with one explicit action`, async ({ context, page }) => {
    const state = await setup(context, page, { webln: wallet === "WebLN" });
    if (wallet === "NWC") await connectNwc(page);
    await backToForm(page);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0);
    await page.getByRole("button", { name: "Pay & Boost 210 sats", exact: true }).click();
    // Settlement is polled every 3s, separately from the wallet's send response.
    await expect(page.getByText("Added 168 sats to visibility.", { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Author support: 42 sats, payment verified.", { exact: true })).toBeVisible();
    expect(state.boardRequests).toHaveLength(1); expect(state.authorRequests).toHaveLength(1);
    expect(state.boardCharges).toBe(1); expect(state.authorCharges).toBe(1); expect(state.errors).toEqual([]);
});

test("global connections and legacy ranking help work without promotion", async ({ context, page }) => {
    const state = await setup(context, page);
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("navigation", { name: "Connections and help", exact: true }).getByRole("button", { name: "Wallet", exact: true }).click();
    await expect(page.getByLabel("NWC connection string")).toBeVisible();
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.goto("/#how-ranking-works");
    await expect(page.getByRole("heading", { name: "How ranking works", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Boost|Promote) .* sats$/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.goto("/help#other-ways-to-promote");
    await expect(page.getByRole("heading", { name: "Other ways to promote", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy relay URL", exact: true })).toBeVisible();
    expect(state.boardRequests).toHaveLength(0); expect(state.authorRequests).toHaveLength(0); expect(state.errors).toEqual([]);
});

test("allocation bounds and panel focus remain usable with a smaller viewport", async ({ context, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = await setup(context, page);
    await openSupport(page);
    const slider = page.getByRole("slider", { name: "Holoboard share in percent" });
    await slider.focus(); await slider.press("Home");
    await expect(slider).toHaveValue("1");
    await expect(page.getByRole("region", { name: "Payment split" }).locator('[aria-label="Holoboard visibility"]').getByText("3 sats", { exact: true })).toBeVisible();
    await slider.press("End");
    await expect(slider).toHaveValue("100");
    await backToForm(page);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    await page.getByRole("button", { name: "Close dialog", exact: true }).focus();
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Close dialog", exact: true })).toBeFocused();
    await page.setViewportSize({ width: 390, height: 480 });
    await expect.poll(async () => {
        const bounds = await page.getByRole("button", { name: "Boost 210 sats", exact: true }).boundingBox();
        return bounds ? bounds.y + bounds.height : 1000;
    }).toBeLessThanOrEqual(480);
    await openPaymentOptions(page);
    await page.getByRole("checkbox", { name: "Send me a confirmation DM", exact: true }).check();
    await expect(page.getByRole("textbox", { name: "Npub for confirmation", exact: true })).toBeVisible();
    const back = page.getByRole("button", { name: "< Back to boost", exact: true });
    const backBounds = await back.boundingBox();
    expect(backBounds!.y + backBounds!.height).toBeLessThanOrEqual(480);
    await back.click();
    await expect(slider).toHaveValue("100");
    expect(state.boardRequests).toHaveLength(0); expect(state.authorRequests).toHaveLength(0); expect(state.errors).toEqual([]);
});
