import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import * as nip04 from "nostr-tools/nip04";
import { neventEncode, npubEncode } from "nostr-tools/nip19";
import { bytesToHex } from "nostr-tools/utils";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { walletInvoice } from "./helpers/walletFixture";

// Route-based API mocks cannot intercept requests owned by a service worker.
// The PWA suite exercises worker updates with a real local mock API instead.
test.use({ serviceWorkers: "block" });

const walletKey = generateSecretKey(), signerKey = generateSecretKey(), userKey = generateSecretKey();
const walletPubkey = getPublicKey(walletKey);
const clientKey = generateSecretKey();
const note = finalizeEvent({ kind: 1, created_at: 1700000000, tags: [], content: "A note for isolated payment tests." }, userKey);
const boardPreimage = "b".repeat(64), authorPreimage = "c".repeat(64);
const hash = (preimage: string) => createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
const boardHash = hash(boardPreimage);
const walletUri = `nostr+walletconnect://${walletPubkey}?relay=ws%3A%2F%2F127.0.0.1%3A3334&secret=${bytesToHex(clientKey)}`;
const otherNote = finalizeEvent({ kind: 1, created_at: 1700000001, tags: [], content: "A different note for isolated payment tests." }, userKey);
const otherBoardHash = hash("d".repeat(64));
type Options = { secondNote?: boolean; deferAuthorResponse?: boolean; badAuthorProof?: boolean; validAuthorInvoice?: boolean; mockInvoice?: boolean; noteContent?: string; rank?: number; targets?: { rank: number; weight: number }[]; authorMinSats?: number; authorShare?: number; newCampaign?: boolean; expiredCampaign?: boolean; authorUnavailable?: "no_address" | "unavailable"; blockStorage?: boolean; encryption?: "nip44_v2" | "nip04"; failAuthor?: boolean; loseAuthorResponse?: boolean; failAuthorInvoice?: boolean; extension?: boolean; deferSigner?: boolean; authorExpiresIn?: number; boardExpiresIn?: number; webln?: boolean; lookupState?: "pending" | "unknown" };

async function setup(context: BrowserContext, page: Page, options: Options = {}) {
    const appOrigin = new URL(test.info().project.use.baseURL!).origin;
    const appSocket = appOrigin.replace(/^http/, "ws");
    const promotedNote = options.noteContent ? finalizeEvent({ kind: 1, created_at: 1700000000, tags: [], content: options.noteContent }, userKey) : note;
    if (options.blockStorage) await context.addInitScript(() => {
        Object.defineProperty(window, "sessionStorage", { get: () => { throw new DOMException("Storage blocked by this test", "SecurityError"); } });
    });
    const state = { boardPaid: false, authorPaid: false, boardCharges: 0, authorCharges: 0, authorAttempts: 0, boardProofs: new Map<string, string>([["lnbc-visibility", boardPreimage]]), authorProofs: new Map<string, string>(), expectedSignerPubkey: getPublicKey(userKey), boardRequests: [] as Record<string, unknown>[], authorRequests: [] as Record<string, unknown>[], methods: [] as string[], signerMethods: [] as string[], linkPreviews: [] as string[], errors: [] as string[], completeAuthorPayment: undefined as (() => void) | undefined, approveSigner: undefined as (() => Promise<void>) | undefined };
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
        if (url.pathname === "/api/link-preview") { state.linkPreviews.push(url.searchParams.get("url")!); data = { url: url.searchParams.get("url"), title: "Linked page", description: "Page summary" }; }
        else if (url.pathname === "/api/board/waiting-updates") data = { count: 0, note_ids: [], checked_at: Date.now() };
        else if (url.pathname === "/api/board/campaigns") data = { entries: [entry], targets: options.targets ?? [entry], total: 1, active_posts: 1, has_more: false, total_sats: 210 };
        else if (url.pathname === "/api/promote/preview" && options.secondNote && body.note === otherNote.id) data = { event: otherNote, active: false, sats_paid: 0, weight: 0, rank: 0, billboard_fee_sats: 100, images: [], author_share: 20 };
        else if (url.pathname === "/api/promote/preview") data = { event: promotedNote, active: !options.newCampaign && !options.expiredCampaign, sats_paid: options.newCampaign ? 0 : 210, weight: options.newCampaign || options.expiredCampaign ? 0 : 200, rank: options.newCampaign || options.expiredCampaign ? 0 : options.rank ?? 1, billboard_fee_sats: 100, images: [], author_share: entry.author_share };
        else if (url.pathname === "/api/support") data = { available: !options.authorUnavailable, reason_code: options.authorUnavailable, reason: options.authorUnavailable === "no_address" ? "The author has no Lightning payment address." : "Author support is unavailable. Choose visibility only or try again later.", author: note.pubkey, min_sats: options.authorMinSats ?? 1, max_sats: 10000000, allows_nostr: true, nostr_pubkey: walletPubkey };
        else if (url.pathname === "/api/support/invoice") {
            state.authorRequests.push(body);
            if (options.failAuthorInvoice) { status = 503; data = { error: "Author invoice provider unavailable" }; }
            else {
                if (body.zap_request) { expect(verifyEvent(body.zap_request)).toBe(true); expect(body.zap_request.kind).toBe(9734); expect(body.zap_request.pubkey).toBe(state.expectedSignerPubkey); }
                const issued = state.authorRequests.length;
                const proof = issued === 1 ? authorPreimage : issued.toString(16).padStart(2, "0").repeat(32);
                const paymentHash = hash(proof);
                const invoice = options.validAuthorInvoice ? walletInvoice({ hash: paymentHash, amountMsats: body.amount_sats * 1000 }) : issued === 1 ? "lnbc-author" : `lnbc-author-${issued}`;
                state.authorProofs.set(invoice, proof);
                data = { invoice, payment_hash: paymentHash, amount_sats: body.amount_sats, author: note.pubkey, expires_at: Math.floor(Date.now()/1000)+(options.authorExpiresIn ?? 3600) };
            }
        } else if (url.pathname === "/api/promote") {
            state.boardRequests.push(body);
            if (options.secondNote && body.note === otherNote.id) data = { invoice: "lnbc-other-note", payment_hash: otherBoardHash, amount_sats: body.amount_sats + (body.billboard ? 100 : 0), promotion_sats: body.amount_sats, note_id: otherNote.id, expires_at: Math.floor(Date.now()/1000)+3600, billboard_fee_sats: body.billboard ? 100 : 0 };
            else data = { invoice: options.mockInvoice ? `lnbc${body.amount_sats}...mock_invoice` : "lnbc-visibility", payment_hash: boardHash, amount_sats: body.amount_sats + (body.billboard ? 100 : 0), promotion_sats: body.amount_sats, note_id: promotedNote.id, expires_at: Math.floor(Date.now()/1000)+(options.boardExpiresIn ?? 3600), billboard_fee_sats: body.billboard ? 100 : 0 };
        } else if (url.pathname === "/api/promote/status" && options.secondNote && url.searchParams.get("payment_hash") === otherBoardHash) data = { pending: true, settled: false, sats_paid: 0 };
        else if (url.pathname === "/api/promote/status") data = { pending: !state.boardPaid, settled: state.boardPaid, sats_paid: 210, ...(state.boardPaid ? { receipt: { promotion_sats: state.boardRequests.at(-1)?.amount_sats, fee_converted: false, billboard_applied: false } } : {}) };
        else if (url.pathname === "/api/support/verify") { expect([...state.authorProofs.values()]).toContain(body.preimage); data = { verified: true }; }
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
                    if (state.boardProofs.has(request.params.invoice)) { state.boardCharges++; state.boardPaid = true; result = { preimage: state.boardProofs.get(request.params.invoice) }; }
                    else {
                        state.authorAttempts++;
                        if (options.failAuthor && state.authorAttempts === 1) error = { code: "PAYMENT_FAILED", message: "Author payment failed" };
                        else { state.authorCharges++; state.authorPaid = true; result = { preimage: options.badAuthorProof ? "ff".repeat(32) : state.authorProofs.get(request.params.invoice) }; }
                        if (options.loseAuthorResponse && state.authorAttempts === 1) return;
                    }
                } else if (request.method === "lookup_invoice") {
                    if (options.lookupState === "unknown") error = { code: "NOT_FOUND", message: "No status available" };
                    else {
                        const issued = [...state.authorProofs].find(([, proof]) => hash(proof) === request.params.payment_hash);
                        result = { invoice: issued?.[0], type: "outgoing", payment_hash: request.params.payment_hash, state: options.lookupState ?? (state.authorPaid ? "settled" : "failed"), settled_at: options.lookupState ? 0 : state.authorPaid ? Math.floor(Date.now()/1000) : 0, preimage: options.lookupState || !state.authorPaid ? undefined : issued?.[1] };
                    }
                }
                else throw new Error(`Unexpected NWC method: ${request.method}`);
                const plaintext = JSON.stringify({ result_type: request.method, result, error });
                const content = encryption === "nip04" ? await nip04.encrypt(bytesToHex(walletKey), event.pubkey, plaintext) : nip44.encrypt(plaintext, key);
                const response = finalizeEvent({ kind: 23195, created_at: Math.floor(Date.now()/1000), tags: [["p", event.pubkey], ["e", event.id]], content }, walletKey);
                if (options.deferAuthorResponse && request.method === "pay_invoice" && state.authorProofs.has(request.params.invoice) && state.authorAttempts === 1) {
                    state.completeAuthorPayment = () => sendEvent(response); return;
                }
                sendEvent(response);
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
            if (state.boardProofs.has(invoice)) { state.boardCharges++; state.boardPaid = true; return { preimage: state.boardProofs.get(invoice) }; }
            expect(state.authorProofs.has(invoice)).toBe(true); state.authorAttempts++; state.authorCharges++; state.authorPaid = true;
            return { preimage: state.authorProofs.get(invoice) };
        });
        await context.addInitScript(() => {
            const target = window as unknown as { webln: unknown; testWalletPay(invoice: string): Promise<unknown> };
            target.webln = { enable: async () => {}, sendPayment: (invoice: string) => target.testWalletPay(invoice) };
        });
    }
    page.on("pageerror", (error) => state.errors.push(error.message));
    await page.goto("/");
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    const submit = page.getByRole("button", { name: options.newCampaign || options.expiredCampaign ? /^Promote 210 sats$/ : /^Boost 210 sats$/ });
    if ((options.authorUnavailable && !(options.newCampaign && options.authorUnavailable === "no_address")) || (options.authorMinSats ?? 0) > 42) await expect(submit).toBeDisabled();
    else await expect(submit).toBeEnabled();
    return state;
}
function authorConfirmed(page: Page) {
    return page.getByRole("button", { name: /^Author 42 sats Payment verified$/ })
        .or(page.getByLabel("Author payment", { exact: true }).filter({ hasText: "Payment verified" }));
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
    test.skip(section === "signer" && process.env.VITE_ENABLE_NOSTR_CONNECT !== "true", "Signer UI is disabled for this release.");
    await backToForm(page);
    if (await page.getByRole("tab", { name: "Invoice / QR", exact: true }).isVisible()) {
        if (section === "wallet") {
            await walletMethod(page);
            const settings = page.getByText("Wallet settings", { exact: true });
            if (await settings.isVisible()) await settings.click();
        } else await page.getByRole("button", { name: "Nostr signer settings >", exact: true }).click();
        return;
    }
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
    await page.getByRole("button", { name: /^(Boost|Promote) 210 sats$/ }).click();
}
async function invoiceMethod(page: Page) {
    await page.getByRole("tab", { name: "Invoice / QR", exact: true }).click();
}
async function walletMethod(page: Page) {
    await page.getByRole("tab", { name: "Wallet", exact: true }).click();
}
async function expectSplitInvoices(page: Page) {
    const walletSelected = await page.getByRole("tab", { name: "Wallet", exact: true }).getAttribute("aria-selected") === "true";
    await invoiceMethod(page);
    await page.getByRole("button", { name: /^Holoboard \d+ sats/ }).click();
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", "lightning:lnbc-visibility");
    await expect(page.getByRole("button", { name: "Copy invoice", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^Author \d+ sats/ }).click();
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", "lightning:lnbc-author");
    await expect(page.getByRole("button", { name: "Copy invoice", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^Holoboard \d+ sats/ }).click();
    if (walletSelected) await walletMethod(page);
}
async function connectNwc(page: Page) {
    await openConnections(page, "wallet");
    await page.getByLabel("NWC connection string").fill(walletUri);
    await page.getByRole("button", { name: "Connect NWC wallet", exact: true }).click();
    await expect(page.getByText("Connected: Test NWC wallet.", { exact: false })).toBeVisible();
}

async function savedPayment(page: Page) {
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("holoboard-last-payment"))).not.toBeNull();
    return page.evaluate(() => {
        const key = sessionStorage.getItem("holoboard-last-payment");
        if (!key) throw new Error("Expected an unfinished payment");
        return JSON.parse(sessionStorage.getItem(key)!) as {
            board: Record<string, unknown>; boardAttempt?: Record<string, unknown>;
            author?: { amount_sats: number; author: string; invoice: string; payment_hash: string };
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
    await page.getByRole("button", { name: "Boost 210 sats", exact: true }).click();
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
    await expectSplitInvoices(page);
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
    await expect(page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ })).toBeDisabled();
    await invoiceMethod(page);
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", "lightning:lnbc-author");
    await expect(page.getByText("Author payment not confirmed", { exact: true })).toBeVisible();
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
    await page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ }).click();
    await expect(page.getByText("Added 168 sats to visibility.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "I checked my wallet: author support was not paid", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await expect(page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ })).toBeEnabled();
    await page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ }).click();
    await expect(authorConfirmed(page)).toBeVisible();
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
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Copy invoice", exact: true })).toHaveCount(1);
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
    await expectSplitInvoices(page);
    await page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ }).click();
    await expect(authorConfirmed(page)).toBeVisible();
    await expect(page.getByText("Added 168 sats to visibility.", { exact: true })).toBeVisible();
    expect(state.boardCharges).toBe(1); expect(state.authorCharges).toBe(1);
    expect(state.errors).toEqual([]);
});
test("NWC recovers a failed author payment after reload without paying visibility twice", async ({ context, page }) => {
    const state = await setup(context, page, { failAuthor: true });
    await connectNwc(page);
    await prepareInvoices(page);
    await page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ }).click();
    await expect(page.getByText("Added 168 sats to visibility.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "I checked my wallet: author support was not paid", exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await expect(page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ })).toBeEnabled();
    await page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ }).click();
    await expect(authorConfirmed(page)).toBeVisible();
    expect(state.methods).toContain("lookup_invoice");
    expect(state.boardCharges).toBe(1); expect(state.authorCharges).toBe(1); expect(state.authorAttempts).toBe(2);
    expect(state.boardRequests).toHaveLength(1); expect(state.authorRequests).toHaveLength(1);
    expect(state.errors).toEqual([]);
});
test("NWC recovers a paid author invoice after a lost response", async ({ context, page }) => {
    const state = await setup(context, page, { loseAuthorResponse: true });
    await connectNwc(page);
    await prepareInvoices(page);
    await page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ }).click();
    await expect.poll(() => state.authorCharges).toBe(1);
    await page.reload();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await expect(page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ })).toBeEnabled();
    await page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ }).click();
    await expect(authorConfirmed(page)).toBeVisible();
    expect(state.methods).toContain("lookup_invoice");
    expect(state.boardCharges).toBe(1); expect(state.authorCharges).toBe(1); expect(state.authorAttempts).toBe(1);
    expect(state.errors).toEqual([]);
});
test("promotion and wallet Send share an uncertain author attempt after reload", async ({ context, page }) => {
    const state = await setup(context, page, { loseAuthorResponse: true, validAuthorInvoice: true });
    await connectNwc(page); await prepareInvoices(page);
    await page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ }).click();
    await expect.poll(() => state.authorCharges).toBe(1);
    const invoice = (await savedPayment(page)).author!.invoice;
    await page.reload(); await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await openConnections(page, "wallet");
    await page.getByRole("navigation", { name: "Wallet views" }).getByRole("button", { name: "Send", exact: true }).click();
    await page.getByLabel("Invoice or Lightning Address").fill(invoice);
    await page.getByRole("button", { name: "Review payment", exact: true }).click();
    await expect(page.getByRole("button", { name: "Check payment status", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Check payment status", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Payment complete", exact: true })).toBeVisible({ timeout: 10000 });
    await backToForm(page);
    await expect(authorConfirmed(page)).toBeVisible();
    expect(state.authorAttempts).toBe(1); expect(state.authorCharges).toBe(1); expect(state.boardCharges).toBe(1);
    expect(state.methods.filter((method) => method === "lookup_invoice")).toHaveLength(1); expect(state.errors).toEqual([]);
});

test("an invalid promotion proof stays unconfirmed in wallet Send and lookup recovers without another charge", async ({ context, page }) => {
    const state = await setup(context, page, { badAuthorProof: true, validAuthorInvoice: true });
    await connectNwc(page); await prepareInvoices(page);
    await page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ }).click();
    await expect(page.getByRole("alert")).toContainText("valid payment proof");
    const saved = await savedPayment(page);
    expect(saved.authorAttempt?.state).toBe("uncertain");
    await openConnections(page, "wallet");
    await page.getByRole("navigation", { name: "Wallet views" }).getByRole("button", { name: "Send", exact: true }).click();
    await page.getByLabel("Invoice or Lightning Address").fill(saved.author!.invoice);
    await page.getByRole("button", { name: "Review payment", exact: true }).click();
    await expect(page.getByText("Payment confirmed.", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Check payment status", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Check payment status", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Payment complete", exact: true })).toBeVisible({ timeout: 10000 });
    expect(state.authorCharges).toBe(1); expect(state.authorAttempts).toBe(1); expect(state.boardCharges).toBe(1);
    expect(state.errors).toEqual([]);
});

test("an author invoice paid in wallet Send is reused by promotion without another charge", async ({ context, page }) => {
    const state = await setup(context, page, { validAuthorInvoice: true });
    await connectNwc(page); await prepareInvoices(page);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("holoboard-last-payment"))).not.toBeNull();
    const invoice = (await savedPayment(page)).author!.invoice;
    await openConnections(page, "wallet");
    await page.getByRole("navigation", { name: "Wallet views" }).getByRole("button", { name: "Send", exact: true }).click();
    await page.getByLabel("Invoice or Lightning Address").fill(invoice);
    await page.getByRole("button", { name: "Review payment", exact: true }).click();
    await page.getByRole("button", { name: "Send 42 sats", exact: true }).click();
    await expect(page.getByText("Payment confirmed.", { exact: true })).toBeVisible();
    await backToForm(page);
    await expect(authorConfirmed(page)).toBeVisible();
    await page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ }).click();
    await expect(page.getByText("Added 168 sats to visibility.", { exact: true })).toBeVisible();
    expect(state.authorAttempts).toBe(1); expect(state.authorCharges).toBe(1); expect(state.boardCharges).toBe(1);
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
    await expect(page.getByRole("button", { name: /^Author 42 sats/ })).toBeVisible();
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
    await expect(page.getByRole("button", { name: /^Author 42 sats/ })).toBeVisible();
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
    await expect(page.getByRole("button", { name: /^Holoboard 210 sats/ })).toBeVisible();
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
    await expect(page.getByRole("button", { name: /^Author 42 sats/ })).toBeVisible();
    expect(state.authorRequests[0]).not.toHaveProperty("zap_request");
    expect(state.boardRequests[0].amount_sats).toBe(168);
    expect(state.errors).toEqual([]);
});

for (const wallet of ["NWC", "WebLN"] as const) {
    for (const expired of ["author", "visibility"] as const) test(`${wallet} pays the valid recipient when ${expired} invoice expired`, async ({ context, page }) => {
        const state = await setup(context, page, { webln: wallet === "WebLN", authorExpiresIn: expired === "author" ? -1 : 3600, boardExpiresIn: expired === "visibility" ? -1 : 3600 });
        if (wallet === "NWC") await connectNwc(page);
        await prepareInvoices(page);
        await walletMethod(page);
        const pay = page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ });
        await expect(pay).toBeEnabled();
        await pay.click();
        if (expired === "author") {
            await expect(page.getByText("Added 168 sats to visibility.", { exact: true })).toBeVisible();
            await expect(page.getByText("The author invoice expired.", { exact: false })).toBeVisible();
            expect(state.boardCharges).toBe(1); expect(state.authorCharges).toBe(0); expect(state.authorAttempts).toBe(0);
        } else {
            await expect(authorConfirmed(page)).toBeVisible();
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
    await page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ }).click();
    await expect.poll(() => state.authorCharges).toBe(1);
    await expect(page.getByRole("button", { name: "Back to promotion", exact: true })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Processing author support." })).toBeVisible();
    await expect(page.getByRole("button", { name: "I checked my wallet: author support was not paid", exact: true })).toHaveCount(0);
    await page.clock.fastForward(60001);
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
    await expect(page.getByRole("button", { name: "Check payment status", exact: true })).toBeEnabled();
    const before = await savedPayment(page);
    await page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ }).click();
    await expect(authorConfirmed(page)).toBeVisible();
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
    await page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ }).click();
    await expect(page.getByRole("button", { name: "I checked my wallet: author support was not paid", exact: true })).toBeVisible();
    await page.clock.fastForward(3601000);
    await expect(page.getByText("The author invoice expired.", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ }).click();
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
    await expectSplitInvoices(page);

    await page.getByRole("button", { name: /^Author \d+ sats/ }).click();
    await expect(page.getByRole("img", { name: "Support the original author invoice QR code" })).toBeVisible();
    await page.getByRole("button", { name: /^Holoboard \d+ sats/ }).click();
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
    await page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ }).click();
    await expect(page.getByText("Added 168 sats to visibility.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "I checked my wallet: author support was not paid", exact: true })).toBeVisible();
    await page.clock.fastForward(3601000);
    await expect(page.getByText("The author invoice expired.", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ }).click();
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
    await expect(page.getByRole("button", { name: /^Author 42 sats/ })).toBeVisible();
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
            await page.getByRole("button", { name: /^(Pay \d+ sats|Check & pay up to \d+ sats|Check payment status)$/ }).click();
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
        await expect(page.getByRole("button", { name: /^Author 42 sats/ })).toBeVisible();
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
        await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
        await expect(page.getByRole("button", { name: "Prepare invoices only", exact: true })).toHaveCount(0);
        await prepareInvoices(page);
        await expectSplitInvoices(page);

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
    await page.getByRole("button", { name: "Custom", exact: true }).click();
    await expect(page.getByRole("spinbutton", { name: "Custom total in sats" })).toHaveValue("251");
    await page.getByRole("button", { name: "Target position", exact: true }).click();
    await openSupport(page);
    await setAuthorShare(page, 50);
    await expect(page.getByRole("region", { name: "Payment split" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reach rank 21, estimated total 401 sats", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: "Boost 251 sats", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Help >", exact: true }).click();
    await expect(page.getByRole("heading", { name: "How ranking works", exact: true })).toBeVisible();
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
    await expect(page.getByRole("button", { name: /^Holoboard 401 sats/ })).toBeVisible();
    expect(state.boardRequests[0]).toMatchObject({ amount_sats: 401, author_share: 50 });
    expect(state.authorRequests[0].amount_sats).toBe(400);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
});

test("public author zap is reachable by keyboard without gating invoices", async ({ context, page }) => {
    test.skip(process.env.VITE_ENABLE_NOSTR_CONNECT !== "true", "Signer UI is disabled for this release.");
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
    await expectSplitInvoices(page);
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
    await expectSplitInvoices(page);
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
    test.skip(process.env.VITE_ENABLE_NOSTR_CONNECT !== "true", "Signer UI is disabled for this release.");
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
    await expect(page.getByText("No higher target positions available.", { exact: false })).toBeVisible();
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
    await expectSplitInvoices(page);
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
    await expect(page.getByRole("tablist", { name: "Payment method", exact: true })).toBeVisible();
    await expectSplitInvoices(page);
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

for (const wallet of ["NWC", "WebLN"] as const) test(`${wallet} quick boost prepares invoices before explicit payment`, async ({ context, page }) => {
    const state = await setup(context, page, { webln: wallet === "WebLN" });
    if (wallet === "NWC") await connectNwc(page);
    await backToForm(page);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0);
    await page.getByRole("button", { name: "Boost 210 sats", exact: true }).click();
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0);
    await walletMethod(page);
    await page.getByRole("button", { name: /^Pay 210 sats$/ }).click();
    // Settlement is polled every 3s, separately from the wallet's send response.
    await expect(page.getByText("Added 168 sats to visibility.", { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(authorConfirmed(page)).toBeVisible();
    expect(state.boardRequests).toHaveLength(1); expect(state.authorRequests).toHaveLength(1);
    expect(state.boardCharges).toBe(1); expect(state.authorCharges).toBe(1); expect(state.errors).toEqual([]);
});

test("global connections and legacy ranking help work without promotion", async ({ context, page }) => {
    const state = await setup(context, page);
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("navigation", { name: "Connections", exact: true }).getByRole("button", { name: "Wallet", exact: true }).click();
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

for (const wallet of ["none", "NWC", "WebLN"] as const) test(`payment methods default and preserve selection with ${wallet}`, async ({ context, page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    const state = await setup(context, page, { webln: wallet === "WebLN" });
    if (wallet === "NWC") await connectNwc(page);
    await prepareInvoices(page);
    const tabs = page.getByRole("tablist", { name: "Payment method", exact: true });
    await expect(tabs.getByRole("tab").first()).toHaveText(wallet === "NWC" ? "Wallet" : "Invoice / QR");
    await expect(tabs.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0);
    await expectSplitInvoices(page);
    await invoiceMethod(page);
    await page.getByRole("button", { name: /^Author 42 sats/ }).click();
    const before = await savedPayment(page);
    await page.getByRole("button", { name: "Payment help >", exact: true }).click();
    await backToForm(page);
    await expect(tabs.getByRole("tab", { name: "Invoice / QR", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", "lightning:lnbc-author");
    await tabs.getByRole("tab", { name: "Invoice / QR", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.getByRole("tab", { name: "Wallet", exact: true })).toBeFocused();
    await expect(tabs.getByRole("tab", { name: "Wallet", exact: true })).toHaveAttribute("aria-selected", "true");
    await invoiceMethod(page);
    await expect(page.getByRole("img", { name: "Support the original author invoice QR code", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`payment-invoice-${wallet}-320.png`) });
    const qrBounds = await page.getByRole("img", { name: "Support the original author invoice QR code", exact: true }).boundingBox();
    const footerTop = (await page.getByRole("link", { name: "Open in wallet", exact: true }).boundingBox())!.y;
    expect(qrBounds!.y + qrBounds!.height).toBeLessThanOrEqual(footerTop);
    const linkBounds = await page.getByRole("link", { name: "Open in wallet", exact: true }).boundingBox();
    expect(linkBounds!.y + linkBounds!.height).toBeLessThanOrEqual(740);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const after = await savedPayment(page);
    expect(after.board).toEqual(before.board); expect(after.author).toEqual(before.author);
    expect(state.boardRequests).toHaveLength(1); expect(state.authorRequests).toHaveLength(1);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
});

test("connecting and disconnecting inside payment preserves invoices and tab order", async ({ context, page }) => {
    const state = await setup(context, page);
    await prepareInvoices(page);
    const before = await savedPayment(page);
    await walletMethod(page);
    await page.getByLabel("NWC connection string").fill(walletUri);
    await page.getByRole("button", { name: "Connect NWC wallet", exact: true }).click();
    await expect(page.getByText("NWC: Test NWC wallet", { exact: true })).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Payment method", exact: true }).getByRole("tab").first()).toHaveText("Invoice / QR");
    await page.getByText("Wallet settings", { exact: true }).click();
    await page.getByRole("button", { name: "Disconnect wallet", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Wallet", exact: true })).toHaveAttribute("aria-selected", "true");
    await invoiceMethod(page);
    await expectSplitInvoices(page);
    expect((await savedPayment(page)).board).toEqual(before.board);
    expect((await savedPayment(page)).author).toEqual(before.author);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
});

for (const reopen of ["persistent", "blocked storage", "offline"] as const) test(`restart before expiry clears an unpaid session with ${reopen}`, async ({ context, page }) => {
    const state = await setup(context, page, { blockStorage: reopen === "blocked storage" });
    await setAuthorShare(page, 35);
    await prepareInvoices(page);
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Restart payment", exact: true })).toBeEnabled();
    if (reopen === "offline") await context.route("**/api/promote/status?**", (route) => route.abort());
    await page.getByRole("button", { name: "Restart payment", exact: true }).click();
    await expect(page.getByText("Check your wallet first.", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "I haven't paid, restart", exact: true }).click();
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    await expect(page.getByRole("slider", { name: "Holoboard share in percent" })).toHaveValue("65");
    await expect(page.getByRole("tablist", { name: "Payment method", exact: true })).toHaveCount(0);
    if (reopen !== "blocked storage") {
        expect(await page.evaluate(() => sessionStorage.getItem("holoboard-last-payment"))).toBeNull();
        expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("holoboard-payment:")))).toEqual([]);
    }
    expect(state.boardRequests).toHaveLength(1); expect(state.authorRequests).toHaveLength(1);
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    expect(state.boardRequests).toHaveLength(1);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
});

test("restart restores amount, allocation, appearance and notifications after reload", async ({ context, page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    const state = await setup(context, page, { newCampaign: true });
    await page.getByRole("button", { name: "Custom", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Custom total in sats", exact: true }).fill("500");
    await setAuthorShare(page, 35);
    await page.getByRole("tab", { name: /^Billboard/ }).click();
    await page.getByRole("button", { name: "Billboard / +100 sats", exact: true }).click();
    await page.getByRole("button", { name: "Neon sign", exact: true }).click();
    await openPaymentOptions(page);
    await page.getByRole("checkbox", { name: "Send me a confirmation DM", exact: true }).check();
    await page.getByRole("textbox", { name: "Npub for confirmation", exact: true }).fill(note.pubkey);
    await page.getByRole("button", { name: "Promote 600 sats", exact: true }).click();
    await expect(page.getByRole("button", { name: "Restart payment", exact: true })).toBeEnabled();
    await page.reload();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await page.getByRole("button", { name: "Restart payment", exact: true }).click();
    await page.screenshot({ path: test.info().outputPath("payment-restart-320.png") });
    await page.getByRole("button", { name: "I haven't paid, restart", exact: true }).click();
    await expect(page.getByRole("button", { name: "Promote 600 sats", exact: true })).toBeEnabled();
    await expect(page.getByRole("spinbutton", { name: "Custom total in sats", exact: true })).toHaveValue("500");
    await expect(page.getByRole("slider", { name: "Holoboard share in percent" })).toHaveValue("65");
    await page.getByRole("tab", { name: /^Billboard/ }).click();
    await expect(page.getByRole("button", { name: "Neon sign", exact: true })).toHaveAttribute("aria-pressed", "true");
    await openPaymentOptions(page);
    await expect(page.getByRole("checkbox", { name: "Send me a confirmation DM", exact: true })).toBeChecked();
    await expect(page.getByRole("textbox", { name: "Npub for confirmation", exact: true })).toHaveValue(note.pubkey);
    expect(state.boardRequests).toHaveLength(1); expect(state.authorRequests).toHaveLength(1);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
});

for (const part of ["board", "author"] as const) for (const stateName of ["submitted", "uncertain", "paid", "reported"] as const) {
    if (part === "board" && stateName === "reported") continue;
    test(`return to promotion retains expired ${part} ${stateName}`, async ({ context, page }) => {
        const state = await setup(context, page, { boardExpiresIn: -1, authorExpiresIn: -1 });
        await prepareInvoices(page);
        await expect(page.getByRole("button", { name: "Restart payment", exact: true })).toBeEnabled();
        // Close the live view before seeding recovery state, so its pending
        // persistence effect cannot overwrite the fixture with an older snapshot.
        await page.getByRole("button", { name: "Close dialog", exact: true }).click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await page.evaluate(({ part, stateName }) => {
            const key = sessionStorage.getItem("holoboard-last-payment")!;
            const payment = JSON.parse(sessionStorage.getItem(key)!);
            if (stateName === "paid") { if (part === "board") payment.promotionPaid = true; else payment.tipStatus = "confirmed"; }
            else if (stateName === "reported") payment.tipStatus = "reported";
            else payment[part === "board" ? "boardAttempt" : "authorAttempt"] = { state: stateName, walletId: "previous-wallet" };
            sessionStorage.setItem(key, JSON.stringify(payment));
        }, { part, stateName });
        await page.reload();
        await page.getByRole("button", { name: "Boost", exact: true }).first().click();
        await expect(page.getByRole("button", { name: "Back to promotion", exact: true })).toBeVisible();
        await walletMethod(page);
        await page.getByRole("button", { name: "Back to promotion", exact: true }).click();
        await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
        await expect(page.getByText("Previous payment for this note", { exact: true })).toBeVisible();
        const retained = await savedPayment(page);
        expect(retained.editing).toBe(true);
        if (stateName === "paid") expect(part === "board" ? retained.promotionPaid : retained.tipStatus === "confirmed").toBe(true);
        else if (stateName === "reported") expect(retained.tipStatus).toBe("reported");
        else expect(retained[part === "board" ? "boardAttempt" : "authorAttempt"]?.state).toBe(stateName);
        await page.getByRole("button", { name: "Resume payment", exact: true }).click();
        await expect(page.getByRole("button", { name: "Back to promotion", exact: true })).toBeVisible();
        expect(state.boardRequests).toHaveLength(1); expect(state.authorRequests).toHaveLength(1);
        expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
    });
}

test("restart checks settlement and retains an already paid visibility invoice", async ({ context, page }) => {
    const state = await setup(context, page);
    await prepareInvoices(page);
    await page.getByRole("button", { name: "Restart payment", exact: true }).click();
    state.boardPaid = true;
    await page.getByRole("button", { name: "I haven't paid, restart", exact: true }).click();
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Resume payment", exact: true }).click();
    await expect(page.getByRole("button", { name: "Back to promotion", exact: true })).toBeVisible();
    await expect(page.getByText("Added 168 sats to visibility.", { exact: true })).toBeVisible();
    expect((await savedPayment(page)).promotionPaid).toBe(true);
    expect(state.boardRequests).toHaveLength(1); expect(state.errors).toEqual([]);
});

test("invoice confirmation keeps its recipient until the next invoice is selected", async ({ context, page }) => {
    const state = await setup(context, page);
    await prepareInvoices(page);
    state.boardPaid = true;
    await expect(page.getByRole("button", { name: "Next invoice: Author", exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "Support the original author invoice QR code", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Next invoice: Author", exact: true }).click();
    await expect(page.getByRole("img", { name: "Support the original author invoice QR code", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "I paid the author, checked my wallet", exact: true }).click();
    await expect(page.getByLabel("Author payment", { exact: true }).filter({ hasText: "Marked paid by you, unverified" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Promotion active", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Payment complete", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Payment summary")).toContainText(/Invoice total\s*210 sats/);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
});

test("a late settlement response from an abandoned session cannot confirm new invoices", async ({ context, page }) => {
    const state = await setup(context, page);
    let release: (() => void) | undefined;
    let checks = 0;
    await page.route("**/api/promote/status?**", async (route) => {
        if (++checks !== 1) return route.fallback();
        await new Promise<void>((resolve) => { release = resolve; });
        try {
            await route.fulfill({ contentType: "application/json", body: JSON.stringify({ settled: true, receipt: { promotion_sats: 999 } }) });
        } catch { /* The abandoned session aborts its poll request. */ }
    });
    await prepareInvoices(page);
    await expect.poll(() => !!release).toBe(true);
    await page.getByRole("button", { name: "Restart payment", exact: true }).click();
    await page.getByRole("button", { name: "I haven't paid, restart", exact: true }).click();
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    await prepareInvoices(page);
    await expect(page.getByRole("button", { name: "Restart payment", exact: true })).toBeEnabled();
    release!();
    await expect(page.getByRole("button", { name: /^Holoboard 168 sats Awaiting payment$/ })).toBeVisible();
    expect((await savedPayment(page)).promotionPaid).toBe(false);
    expect(state.boardRequests).toHaveLength(2); expect(state.authorRequests).toHaveLength(2);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
});

test("legacy sessions restart with known amount and allocation", async ({ context, page }) => {
    const state = await setup(context, page);
    await setAuthorShare(page, 35);
    await page.getByRole("button", { name: "Custom", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Custom total in sats", exact: true }).fill("500");
    await page.getByRole("button", { name: "Boost 500 sats", exact: true }).click();
    await expect(page.getByRole("button", { name: "Restart payment", exact: true })).toBeEnabled();
    await page.evaluate(() => {
        const key = sessionStorage.getItem("holoboard-last-payment")!;
        const payment = JSON.parse(sessionStorage.getItem(key)!);
        delete payment.draft;
        sessionStorage.setItem(key, JSON.stringify(payment));
    });
    await page.reload();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await page.getByRole("button", { name: "Restart payment", exact: true }).click();
    await page.getByRole("button", { name: "I haven't paid, restart", exact: true }).click();
    await expect(page.getByRole("button", { name: "Boost 500 sats", exact: true })).toBeEnabled();
    await expect(page.getByRole("slider", { name: "Holoboard share in percent" })).toHaveValue("65");
    expect(state.boardRequests).toHaveLength(1); expect(state.authorRequests).toHaveLength(1); expect(state.errors).toEqual([]);
});

test("restart preserves NWC connection and unrelated shared payment protection", async ({ context, page }) => {
    const state = await setup(context, page);
    await connectNwc(page);
    await prepareInvoices(page);
    await expect(page.getByRole("button", { name: "Restart payment", exact: true })).toBeEnabled();
    const protectedHash = "d".repeat(64);
    const protectedRecord = { attempt: { state: "uncertain", walletId: "other-wallet" }, invoice: "lnbc-other" };
    await page.evaluate(({ protectedHash, protectedRecord }) => {
        sessionStorage.setItem("holoboard-wallet-attempts", JSON.stringify({ [protectedHash]: protectedRecord }));
    }, { protectedHash, protectedRecord });
    await page.reload();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await expect(page.getByRole("tablist", { name: "Payment method", exact: true }).getByRole("tab").first()).toHaveText("Wallet");
    await page.getByRole("button", { name: "Restart payment", exact: true }).click();
    await page.getByRole("button", { name: "I haven't paid, restart", exact: true }).click();
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => sessionStorage.getItem("holoboard-nwc"))).toBe(walletUri);
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("holoboard-wallet-attempts")!))).toEqual({ [protectedHash]: protectedRecord });
    expect(state.boardRequests).toHaveLength(1); expect(state.authorRequests).toHaveLength(1);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
});

test("closing before WebLN enable completes prevents a later automatic send", async ({ context, page }) => {
    const state = await setup(context, page, { webln: true });
    await page.evaluate(() => {
        const target = window as unknown as { webln: { enable(): Promise<void> }; finishEnable(): void };
        target.webln.enable = () => new Promise<void>((resolve) => { target.finishEnable = resolve; });
    });
    await prepareInvoices(page);
    await walletMethod(page);
    await page.getByRole("button", { name: "Pay 210 sats", exact: true }).click();
    await expect(page.getByRole("button", { name: "Back to promotion", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await page.getByRole("button", { name: "Restart payment", exact: true }).click();
    await page.getByRole("button", { name: "I haven't paid, restart", exact: true }).click();
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    await page.evaluate(() => (window as unknown as { finishEnable(): void }).finishEnable());
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
});

test("each anonymous recipient can be scanned and copied without a connection", async ({ context, page }) => {
    const state = await setup(context, page);
    await page.evaluate(() => {
        const target = window as unknown as { copiedInvoices: string[] };
        target.copiedInvoices = [];
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
            writeText: async (value: string) => { target.copiedInvoices.push(value); },
        } });
    });
    await prepareInvoices(page);
    for (const part of [{ name: /^Holoboard 168 sats/, invoice: "lnbc-visibility", label: "Holoboard visibility" }, { name: /^Author 42 sats/, invoice: "lnbc-author", label: "Support the original author" }]) {
        await page.getByRole("button", { name: part.name }).click();
        await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", `lightning:${part.invoice}`);
        const qr = page.getByRole("img", { name: `${part.label} invoice QR code`, exact: true });
        await expect(qr).toBeVisible();
        const png = PNG.sync.read(await qr.screenshot({ path: test.info().outputPath(`qr-${part.invoice}.png`) }));
        expect(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data.toLowerCase()).toBe(part.invoice);
        await page.getByRole("button", { name: "Copy invoice", exact: true }).click();
        await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    }
    expect(await page.evaluate(() => (window as unknown as { copiedInvoices: string[] }).copiedInvoices)).toEqual(["lnbc-visibility", "lnbc-author"]);
    expect(state.methods).toEqual([]); expect(state.signerMethods).toEqual([]);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("promotion-payment-invoice.png") });
    await walletMethod(page);
    await page.screenshot({ path: test.info().outputPath("promotion-payment-wallet.png") });
});

for (const wallet of ["NWC", "WebLN"] as const) test(`${wallet} replaces expired visibility without charging confirmed author support again`, async ({ context, page }) => {
    const state = await setup(context, page, { boardExpiresIn: -1, webln: wallet === "WebLN" });
    if (wallet === "NWC") await connectNwc(page);
    await prepareInvoices(page);
    await walletMethod(page);
    await page.getByRole("button", { name: "Pay 42 sats", exact: true }).click();
    await expect(authorConfirmed(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to promotion", exact: true })).toBeVisible();
    const before = await savedPayment(page);
    const newProof = "e".repeat(64), newHash = hash(newProof), newInvoice = "lnbc-visibility-replaced";
    state.boardProofs.set(newInvoice, newProof);
    await page.route("**/api/promote", async (route) => {
        if (route.request().method() === "OPTIONS") return route.fallback();
        const body = route.request().postDataJSON();
        state.boardRequests.push(body);
        await route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify({
            invoice: newInvoice, payment_hash: newHash, amount_sats: body.amount_sats,
            promotion_sats: body.amount_sats, note_id: note.id, expires_at: Math.floor(Date.now()/1000)+3600, billboard_fee_sats: 0,
        }) });
    });
    await page.getByRole("button", { name: "Replace visibility invoice after checking wallet", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pay 168 sats", exact: true })).toBeEnabled();
    const replaced = await savedPayment(page);
    expect(replaced.board.paymentHash).toBe(newHash);
    expect(replaced.author).toEqual(before.author); expect(replaced.authorAttempt).toEqual(before.authorAttempt);
    expect(replaced.tipStatus).toBe("confirmed"); expect(state.authorCharges).toBe(1); expect(state.boardCharges).toBe(0);
    await page.getByRole("button", { name: "Pay 168 sats", exact: true }).click();
    await expect(page.getByText("Added 168 sats to visibility.", { exact: true })).toBeVisible();
    expect(state.authorCharges).toBe(1); expect(state.authorAttempts).toBe(1); expect(state.boardCharges).toBe(1);
    expect(state.authorRequests).toHaveLength(1); expect(state.boardRequests).toHaveLength(2); expect(state.errors).toEqual([]);
});

test("a late wallet response cannot overwrite a replacement visibility invoice after reopening", async ({ context, page }) => {
    const state = await setup(context, page, { boardExpiresIn: -1, deferAuthorResponse: true });
    await connectNwc(page); await prepareInvoices(page);
    await page.getByRole("button", { name: "Pay 42 sats", exact: true }).click();
    await expect.poll(() => !!state.completeAuthorPayment).toBe(true);
    const before = await savedPayment(page);
    expect(before.authorAttempt?.state).toBe("uncertain");
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    const newHash = hash("e".repeat(64));
    await page.route("**/api/promote", async (route) => {
        if (route.request().method() === "OPTIONS") return route.fallback();
        const body = route.request().postDataJSON(); state.boardRequests.push(body);
        await route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify({
            invoice: "lnbc-visibility-replaced", payment_hash: newHash, amount_sats: body.amount_sats,
            promotion_sats: body.amount_sats, note_id: note.id, expires_at: Math.floor(Date.now()/1000)+3600, billboard_fee_sats: 0,
        }) });
    });
    await page.getByRole("button", { name: "Replace visibility invoice after checking wallet", exact: true }).click();
    await expect.poll(async () => (await savedPayment(page)).board.paymentHash).toBe(newHash);
    state.completeAuthorPayment!();
    await expect(authorConfirmed(page)).toBeVisible();
    const after = await savedPayment(page);
    expect(after.board.paymentHash).toBe(newHash); expect(after.promotionPaid).toBe(false);
    expect(after.author).toEqual(before.author); expect(after.authorAttempt?.state).toBe("submitted");
    expect(state.authorCharges).toBe(1); expect(state.authorAttempts).toBe(1); expect(state.boardCharges).toBe(0);
    expect(state.boardRequests).toHaveLength(2); expect(state.authorRequests).toHaveLength(1); expect(state.errors).toEqual([]);
});

test("NWC progress stays calm and a complete payment ends with Done", async ({ context, page }, testInfo) => {
    const state = await setup(context, page, { deferAuthorResponse: true });
    await connectNwc(page); await prepareInvoices(page);
    await page.getByRole("button", { name: "Pay 210 sats", exact: true }).click();
    await expect.poll(() => !!state.completeAuthorPayment).toBe(true);
    const progress = page.getByRole("status").filter({ hasText: "Processing author support." });
    await expect(progress).toBeVisible();
    await expect(progress.locator('[class*="text-neon-gold"]')).toHaveCount(0);
    await expect(page.getByText("Author payment not confirmed", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Payment complete", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("nwc-progress.png") });
    state.completeAuthorPayment!();
    const heading = page.getByRole("heading", { name: "Payment complete", exact: true });
    await expect(heading).toBeVisible({ timeout: 10000 });
    await expect(heading).toBeFocused();
    await expect(page.getByLabel("Payment summary")).toContainText(/Total paid\s*210 sats/);
    await expect(page.getByRole("tab", { name: "Wallet", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Restart payment", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("payment-complete.png") });
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    expect(state.boardRequests).toHaveLength(1); expect(state.authorRequests).toHaveLength(1);
    expect(state.boardCharges).toBe(1); expect(state.authorCharges).toBe(1); expect(state.errors).toEqual([]);
});

test("anonymous invoice completion can return to a new boost without issuing invoices", async ({ context, page }) => {
    const state = await setup(context, page, { authorShare: 0 });
    await prepareInvoices(page);
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toBeVisible();
    state.boardPaid = true;
    await expect(page.getByRole("heading", { name: "Payment complete", exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByLabel("Payment summary")).toContainText(/Total paid\s*210 sats/);
    await expect(page.getByRole("img", { name: /invoice QR code$/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Make another payment", exact: true }).click();
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    expect(state.boardRequests).toHaveLength(1); expect(state.authorRequests).toHaveLength(0);
    expect(state.boardCharges).toBe(0); expect(state.errors).toEqual([]);
});

test("WebLN completion survives contextual help", async ({ context, page }) => {
    const state = await setup(context, page, { webln: true });
    await prepareInvoices(page); await walletMethod(page);
    await page.getByRole("button", { name: "Pay 210 sats", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Payment complete", exact: true })).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: "Payment help >", exact: true }).click();
    await backToForm(page);
    await expect(page.getByRole("heading", { name: "Payment complete", exact: true })).toBeFocused();
    await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
    expect(state.boardCharges).toBe(1); expect(state.authorCharges).toBe(1); expect(state.errors).toEqual([]);
});

test("submitted NWC payment uses a neutral verification panel until confirmed", async ({ context, page }) => {
    const state = await setup(context, page);
    let allowVerification = false;
    await page.route("**/api/support/verify", (route) => allowVerification ? route.fallback() : route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Verification temporarily unavailable" }) }));
    await connectNwc(page); await prepareInvoices(page);
    await page.getByRole("button", { name: "Pay 210 sats", exact: true }).click();
    const progress = page.getByRole("status").filter({ hasText: "Verifying author support" });
    await expect(progress).toBeVisible();
    await expect(progress.locator('[class*="text-neon-gold"]')).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Payment complete", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Back to promotion", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Check payment status", exact: true })).toBeEnabled();
    allowVerification = true;
    await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
    await expect(page.getByRole("heading", { name: "Payment complete", exact: true })).toBeVisible({ timeout: 10000 });
    expect(state.boardCharges).toBe(1); expect(state.authorCharges).toBe(1); expect(state.authorAttempts).toBe(1);
    expect(state.errors).toEqual([]);
});

for (const viewport of [{ width: 320, height: 640 }, { width: 1280, height: 720 }]) for (const newCampaign of [false, true]) {
    test(`amount picker stays still in ${newCampaign ? "promote" : "boost"} at ${viewport.width}px`, async ({ context, page }) => {
        await page.setViewportSize(viewport);
        const state = await setup(context, page, { newCampaign, rank: 25, targets: [{ rank: 21, weight: 400 }, { rank: 3, weight: 500 }, { rank: 2, weight: 600 }, { rank: 1, weight: 700 }] });
        const legend = page.getByText("Amount in sats", { exact: true });
        const custom = page.getByRole("button", { name: "Custom", exact: true });
        const before = await legend.boundingBox();
        const customBefore = await custom.boundingBox();
        await page.getByRole("button", { name: "Target position", exact: true }).click();
        expect((await legend.boundingBox())!.y).toBeCloseTo(before!.y, 0);
        expect((await custom.boundingBox())!.y).toBeCloseTo(customBefore!.y, 0);
        await expect(page.getByRole("button", { name: "How ranking works >", exact: true })).toHaveCount(0);
        await custom.click();
        await page.getByRole("spinbutton", { name: "Custom total in sats" }).fill("500");
        const edited = await legend.boundingBox();
        await page.getByRole("button", { name: "Amount", exact: true }).click();
        expect((await legend.boundingBox())!.y).toBeCloseTo(edited!.y, 0);
        await expect(page.getByRole("spinbutton", { name: "Custom total in sats" })).toHaveValue("500");
        await expect(page.getByRole("slider", { name: "Holoboard share in percent" })).toHaveValue("80");
        expect(state.boardRequests).toHaveLength(0); expect(state.authorRequests).toHaveLength(0); expect(state.errors).toEqual([]);
    });
}

test("release UI hides all signer actions and retains manual npub and anonymous invoices", async ({ context, page }) => {
    test.skip(process.env.VITE_ENABLE_NOSTR_CONNECT === "true", "This scenario verifies the release with signer UI disabled.");
    await context.addInitScript(pubkey => sessionStorage.setItem("holoboard-signer", JSON.stringify({ kind: "remote", pubkey, clientKey: "1".repeat(64), pointer: { pubkey, relays: ["ws://127.0.0.1:3334"], secret: null } })), note.pubkey);
    const state = await setup(context, page, { extension: true });
    await expect(page.getByRole("button", { name: /Connect Nostr|Nostr signer settings|Use connected Nostr/ })).toHaveCount(0);
    await expect(page.getByText(/^Public author zap/)).toHaveCount(0);
    await openPaymentOptions(page);
    await page.getByRole("checkbox", { name: "Send me a confirmation DM", exact: true }).check();
    await page.getByRole("textbox", { name: "Npub for confirmation", exact: true }).fill(note.pubkey);
    await expect(page.getByRole("button", { name: /Connect Nostr|Use connected Nostr/ })).toHaveCount(0);
    await backToForm(page);
    await prepareInvoices(page);
    await expectSplitInvoices(page);
    expect(state.authorRequests[0]).not.toHaveProperty("zap_request");
    expect(state.signerMethods).toEqual([]); expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
});

test("a promotion link card appears only after expanding its compact note preview", async ({ context, page }) => {
    const state = await setup(context, page, { noteContent: "Read https://example.com/promotion-article for details." });
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator(".note-link-preview")).toHaveCount(0);
    await page.getByRole("button", { name: "Show full text", exact: true }).click();
    await expect(dialog.getByRole("link", { name: "Open link: Linked page", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Show less", exact: true }).click();
    await expect(dialog.locator(".note-link-preview")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    expect(state.linkPreviews).toEqual(["https://example.com/promotion-article"]);
    expect(state.boardRequests).toHaveLength(0); expect(state.authorRequests).toHaveLength(0); expect(state.errors).toEqual([]);
});

test("new promotion opens a blank editor and Billboard explains note loading", async ({ context, page }, testInfo) => {
    const state = await setup(context, page, { secondNote: true });
    await prepareInvoices(page);
    const previous = await savedPayment(page);
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("button", { name: "Promote a note", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Note link", exact: true })).toHaveValue("");
    await expect(page.getByRole("tablist", { name: "Payment method", exact: true })).toHaveCount(0);
    await expect(page.getByText("Unfinished payments", { exact: true })).toBeVisible();
    const billboard = page.getByRole("tab", { name: "Billboard", exact: true });
    await expect(billboard).toBeEnabled(); await billboard.click();
    await expect(page.getByText("Load a note to preview", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Promote 210 sats", exact: true })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("billboard-before-note.png") });
    await page.getByRole("textbox", { name: "Note link", exact: true }).fill(otherNote.id);
    await expect(page.getByRole("button", { name: "Billboard / +100 sats", exact: true })).toBeEnabled();
    await expect(billboard).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: "Promote 210 sats", exact: true })).toBeEnabled();
    await billboard.press("Home");
    await expect(page.getByText("A different note for isolated payment tests.", { exact: true })).toBeVisible();
    expect((await savedPayment(page)).board).toEqual(previous.board);
    expect(state.boardRequests).toHaveLength(1); expect(state.authorRequests).toHaveLength(1);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
});

test("partial payment can return to editing and resume after reopening", async ({ context, page }, testInfo) => {
    const state = await setup(context, page);
    await prepareInvoices(page);
    state.boardPaid = true;
    await expect(page.getByRole("button", { name: "Next invoice: Author", exact: true })).toBeVisible();
    const previous = await savedPayment(page);
    await page.getByRole("button", { name: "Back to promotion", exact: true }).click();
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    await expect(page.getByText("Previous payment for this note", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("partial-payment-editor.png") });
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Resume payment", exact: true }).click();
    await expect(page.getByRole("img", { name: "Support the original author invoice QR code", exact: true })).toBeVisible();
    const resumed = await savedPayment(page);
    expect(resumed.board).toEqual(previous.board); expect(resumed.author).toEqual(previous.author);
    expect(resumed.promotionPaid).toBe(true); expect(resumed.editing).toBe(false);
    expect(state.boardRequests).toHaveLength(1); expect(state.authorRequests).toHaveLength(1);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
});

test("leaving a pending wallet response cannot affect payment for another note", async ({ context, page }) => {
    const state = await setup(context, page, { deferAuthorResponse: true, secondNote: true });
    await connectNwc(page); await prepareInvoices(page);
    await page.getByRole("button", { name: "Pay 210 sats", exact: true }).click();
    await expect.poll(() => !!state.completeAuthorPayment).toBe(true);
    const old = await savedPayment(page);
    await page.getByRole("button", { name: "Back to promotion", exact: true }).click();
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("button", { name: "Promote a note", exact: true }).click();
    await page.getByRole("textbox", { name: "Note link", exact: true }).fill(otherNote.id);
    await expect(page.getByRole("button", { name: "Promote 210 sats", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Promote 210 sats", exact: true }).click();
    await expect.poll(async () => (await savedPayment(page)).board.noteId).toBe(otherNote.id);
    const current = await savedPayment(page);
    state.completeAuthorPayment!();
    await expect.poll(() => page.evaluate((id) => JSON.parse(sessionStorage.getItem(`holoboard-payment:${id}`)!).authorAttempt?.state, note.id)).toBe("submitted");
    const after = await savedPayment(page);
    expect(after.board).toEqual(current.board); expect(after.author).toEqual(current.author);
    expect(after.promotionPaid).toBe(false); expect(after.tipStatus).toBe("pending");
    expect(old.board.noteId).toBe(note.id);
    await expect(page.getByRole("heading", { name: "Payment complete", exact: true })).toHaveCount(0);
    expect(state.boardCharges).toBe(1); expect(state.authorCharges).toBe(1); expect(state.authorAttempts).toBe(1);
    expect(state.boardRequests).toHaveLength(2); expect(state.authorRequests).toHaveLength(2); expect(state.errors).toEqual([]);
});

test("changing notes resets allocation, appearance and notification draft", async ({ context, page }) => {
    const state = await setup(context, page, { newCampaign: true, secondNote: true });
    await page.getByRole("button", { name: "Custom", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Custom total in sats", exact: true }).fill("500");
    await setAuthorShare(page, 35);
    await page.getByRole("tab", { name: "Billboard", exact: true }).click();
    await page.getByRole("button", { name: "Billboard / +100 sats", exact: true }).click();
    await page.getByRole("tab", { name: "Payment options", exact: true }).click();
    await page.getByRole("checkbox", { name: "Send me a confirmation DM", exact: true }).check();
    await page.getByRole("textbox", { name: "Npub for confirmation", exact: true }).fill(note.pubkey);
    await page.getByRole("tab", { name: "Promotion", exact: true }).click();
    await page.getByRole("button", { name: "Change note", exact: true }).click();
    await page.getByRole("textbox", { name: "Note link", exact: true }).fill(otherNote.id);
    await expect(page.getByRole("button", { name: "Promote 210 sats", exact: true })).toBeEnabled();
    await expect(page.getByRole("slider", { name: "Holoboard share in percent", exact: true })).toHaveValue("80");
    await page.getByRole("tab", { name: "Billboard", exact: true }).click();
    await expect(page.getByRole("button", { name: "Standard / free", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("tab", { name: "Payment options", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "Send me a confirmation DM", exact: true })).not.toBeChecked();
    await page.getByRole("button", { name: "Promote 210 sats", exact: true }).click();
    const prepared = await savedPayment(page);
    expect(prepared.board.noteId).toBe(otherNote.id); expect(prepared.draft.amount).toBe(210);
    expect(prepared.draft.notifyPubkey).toBe(""); expect(prepared.draft.billboardEnabled).toBe(false);
    expect(state.boardRequests).toHaveLength(1); expect(state.authorRequests).toHaveLength(1);
    expect(state.boardCharges).toBe(0); expect(state.errors).toEqual([]);
});

test("expired unattempted payment reopens in the editor and keeps invoices for review", async ({ context, page }) => {
    const state = await setup(context, page, { boardExpiresIn: -1, authorExpiresIn: -1 });
    await prepareInvoices(page);
    const old = await savedPayment(page);
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Resume payment", exact: true }).click();
    await expect(page.getByRole("button", { name: "Restart payment", exact: true })).toBeEnabled();
    expect((await savedPayment(page)).board).toEqual(old.board);
    expect(state.boardRequests).toHaveLength(1); expect(state.authorRequests).toHaveLength(1); expect(state.errors).toEqual([]);
});

test("preparing another payment for the same note preserves the old invoices", async ({ context, page }) => {
    const state = await setup(context, page);
    await prepareInvoices(page);
    state.boardPaid = true;
    await expect(page.getByRole("button", { name: "Next invoice: Author", exact: true })).toBeVisible();
    const old = await savedPayment(page);
    await page.getByRole("button", { name: "Back to promotion", exact: true }).click();
    const nextHash = hash("e".repeat(64));
    await page.route("**/api/promote", async (route) => {
        if (route.request().method() === "OPTIONS") return route.fallback();
        const body = route.request().postDataJSON(); state.boardRequests.push(body);
        await route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify({
            invoice: "lnbc-next-promotion", payment_hash: nextHash, amount_sats: body.amount_sats,
            promotion_sats: body.amount_sats, note_id: note.id, expires_at: Math.floor(Date.now()/1000)+3600, billboard_fee_sats: 0,
        }) });
    });
    await page.route("**/api/promote/status?**", (route) => new URL(route.request().url()).searchParams.get("payment_hash") === nextHash
        ? route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify({ pending: true, settled: false, sats_paid: 0 }) }) : route.fallback());
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Boost 210 sats", exact: true }).click();
    await expect.poll(async () => (await savedPayment(page)).board.paymentHash).toBe(nextHash);
    const current = await savedPayment(page);
    expect(current.author!.payment_hash).not.toBe(old.author!.payment_hash);
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("button", { name: "Promote a note", exact: true }).click();
    await page.getByText("Unfinished payments", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Resume payment", exact: true })).toHaveCount(2);
    await page.getByText("Holoboard: 168 sats, verified.", { exact: false }).locator("..").getByRole("button", { name: "Resume payment", exact: true }).click();
    await expect(page.getByRole("img", { name: "Support the original author invoice QR code", exact: true })).toBeVisible();
    const restored = await savedPayment(page);
    expect(restored.board).toEqual(old.board); expect(restored.author).toEqual(old.author); expect(restored.promotionPaid).toBe(true);
    expect(state.boardRequests).toHaveLength(2); expect(state.authorRequests).toHaveLength(2);
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0); expect(state.errors).toEqual([]);
});

test("returning while WebLN enable waits never sends a later payment", async ({ context, page }) => {
    const state = await setup(context, page, { webln: true });
    await prepareInvoices(page); await walletMethod(page);
    await page.evaluate(() => {
        const target = window as unknown as { webln: { enable(): Promise<void> }; finishEnable?: () => void };
        target.webln.enable = () => new Promise<void>((resolve) => { target.finishEnable = resolve; });
    });
    await page.getByRole("button", { name: "Pay 210 sats", exact: true }).click();
    await page.getByRole("button", { name: "Payment help >", exact: true }).click();
    await expect(page.getByRole("button", { name: "< Back to payment", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "< Back to payment", exact: true }).click();
    await page.getByRole("button", { name: "Back to promotion", exact: true }).click();
    await expect(page.getByRole("button", { name: "Boost 210 sats", exact: true })).toBeEnabled();
    await page.evaluate(() => (window as unknown as { finishEnable?: () => void }).finishEnable?.());
    await page.getByRole("button", { name: "Resume payment", exact: true }).click();
    await walletMethod(page);
    await expect(page.getByRole("button", { name: "Pay 210 sats", exact: true })).toBeEnabled();
    expect(state.boardCharges).toBe(0); expect(state.authorCharges).toBe(0);
    expect((await savedPayment(page)).boardAttempt).toBeUndefined(); expect(state.errors).toEqual([]);
});
