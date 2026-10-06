import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import { bytesToHex } from "nostr-tools/utils";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { addressMetadata, addressMetadataHash, incomingHash, paymentHash, preimage, walletInvoice } from "./helpers/walletFixture";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });
const walletKey = generateSecretKey(), clientKey = generateSecretKey();
const walletPubkey = getPublicKey(walletKey);
const uri = `nostr+walletconnect://${walletPubkey}?relay=ws%3A%2F%2F127.0.0.1%3A3334&secret=${bytesToHex(clientKey)}`;
const methods = ["get_info", "get_balance", "get_budget", "pay_invoice", "make_invoice", "lookup_invoice", "list_transactions"];

async function setup(context: BrowserContext, page: Page, options: { restoredProof?: string | null; methods?: string[]; loseResponse?: boolean; historySize?: number; balanceFailure?: boolean; notifications?: boolean } = {}) {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const permissions = options.methods ?? methods;
    const sentInvoice = walletInvoice();
    if (options.restoredProof !== undefined) await context.addInitScript(({ invoice, hash, walletId, proof }) => {
        const key = "holoboard-wallet-attempts";
        if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, JSON.stringify({ [hash]: {
            attempt: { state: "submitted", walletId, preimage: proof, proofVerified: true }, invoice, amountMsats: 21000,
        } }));
    }, { invoice: sentInvoice, hash: paymentHash, walletId: `nwc:${walletPubkey}:${getPublicKey(clientKey)}`, proof: options.restoredProof });
    const state = {
        balance: 100001, charges: 0, attempts: 0, received: false, paid: false,
        methods: [] as string[], historyRequests: [] as Record<string, number | string>[],
        balanceFailure: !!options.balanceFailure, lookupState: "settled", lookupPreimage: preimage, receiveInvoice: "",
        permissions, errors: [] as string[], notify: (type: "payment_received" | "payment_sent") => { void type; },
    };
    const outgoing = { type: "outgoing", state: "settled", payment_hash: paymentHash, amount: 21000, fees_paid: 1001, description: "Fixture outgoing payment", created_at: 1700000000, settled_at: 1700000001, invoice: sentInvoice };
    const incoming = () => ({ type: "incoming", state: state.received ? "settled" : "pending", payment_hash: incomingHash, amount: 42000, description: "Invoice from Holoboard", created_at: Math.floor(Date.now()/1000), expires_at: Math.floor(Date.now()/1000) + 3600, settled_at: state.received ? Math.floor(Date.now()/1000) : 0, invoice: state.receiveInvoice });
    const transactions = Array.from({ length: options.historySize ?? 2 }, (_, index) => index === 0 ? outgoing : { ...outgoing, type: "incoming", amount: 42000, payment_hash: index.toString(16).padStart(64, "0"), description: `Fixture incoming payment ${index}` });
    await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        let data: unknown;
        if (url.origin === "https://recipient.example") {
            data = url.pathname.startsWith("/.well-known/lnurlp/")
                ? { tag: "payRequest", callback: "https://recipient.example/pay?token=test", minSendable: 1000, maxSendable: 1000000, metadata: addressMetadata }
                : { pr: walletInvoice({ metadataHash: addressMetadataHash }) };
        } else if (url.origin === "http://127.0.0.1:3334") data = { entries: [], targets: [], total: 0, active_posts: 0, has_more: false, total_sats: 0 };
        else return route.abort();
        return route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(data) });
    });
    const publishers: ((event: Event) => void)[] = [];
    await context.routeWebSocket("**/*", (socket) => {
        if (socket.url().startsWith(origin.replace(/^http/, "ws"))) return socket.connectToServer();
        if (!socket.url().startsWith("ws://127.0.0.1:3334")) { socket.close(); return; }
        const subscriptions = new Map<string, Record<string, unknown>>();
        const publish = (event: Event) => {
            for (const [id, filter] of subscriptions) {
                if (!(filter.kinds as number[] | undefined)?.includes(event.kind)) continue;
                if (filter.authors && !(filter.authors as string[]).includes(event.pubkey)) continue;
                if (filter["#e"] && !(filter["#e"] as string[]).some((value) => event.tags.some((tag) => tag[0] === "e" && tag[1] === value))) continue;
                if (filter["#p"] && !(filter["#p"] as string[]).some((value) => event.tags.some((tag) => tag[0] === "p" && tag[1] === value))) continue;
                socket.send(JSON.stringify(["EVENT", id, event]));
            }
        };
        publishers.push(publish);
        socket.onMessage((message) => {
            const msg = JSON.parse(String(message));
            if (msg[0] === "CLOSE") { subscriptions.delete(msg[1]); return; }
            if (msg[0] === "REQ") {
                subscriptions.set(msg[1], msg[2]);
                if (msg[2].kinds?.includes(13194)) publish(finalizeEvent({ kind: 13194, created_at: Math.floor(Date.now()/1000), tags: [["encryption", "nip44_v2"], ...(options.notifications ? [["notifications", "payment_received payment_sent"]] : [])], content: state.permissions.join(" ") }, walletKey));
                socket.send(JSON.stringify(["EOSE", msg[1]])); return;
            }
            if (msg[0] !== "EVENT") return;
            const event = msg[1] as Event;
            expect(verifyEvent(event)).toBe(true);
            socket.send(JSON.stringify(["OK", event.id, true, ""]));
            if (event.kind !== 23194) return;
            const key = nip44.getConversationKey(walletKey, event.pubkey);
            const request = JSON.parse(nip44.decrypt(event.content, key));
            state.methods.push(request.method);
            expect(state.permissions).toContain(request.method);
            let result: unknown, error: unknown = null;
            if (request.method === "get_info") result = { alias: "Fixture wallet", network: "mainnet", methods: state.permissions, lud16: "name@recipient.example", notifications: options.notifications ? ["payment_received", "payment_sent"] : [] };
            else if (request.method === "get_balance") {
                if (state.balanceFailure) error = { code: "INTERNAL", message: "Fixture offline" };
                else result = { balance: state.balance };
            } else if (request.method === "get_budget") result = { used_budget: 21000, total_budget: 1000000, renewal_period: "daily" };
            else if (request.method === "list_transactions") {
                state.historyRequests.push(request.params);
                const filtered = request.params.type ? transactions.filter((tx) => tx.type === request.params.type) : transactions;
                result = { transactions: filtered.slice(request.params.offset ?? 0, (request.params.offset ?? 0) + (request.params.limit ?? 20)) };
            } else if (request.method === "pay_invoice") {
                state.attempts++; state.charges++; state.paid = true; state.balance -= 21002;
                result = { preimage, fees_paid: 2 };
                if (options.loseResponse && state.attempts === 1) return;
            } else if (request.method === "make_invoice") {
                expect(request.params.amount).toBe(42000);
                state.receiveInvoice = walletInvoice({ amountMsats: 42000, hash: incomingHash, description: request.params.description });
                result = incoming();
            } else if (request.method === "lookup_invoice") {
                if (request.params.payment_hash === incomingHash) result = incoming();
                else if (state.lookupState === "unknown") error = { code: "NOT_FOUND", message: "Unknown fixture payment" };
                else result = { ...outgoing, payment_hash: request.params.payment_hash, state: state.lookupState, settled_at: state.lookupState === "settled" ? Math.floor(Date.now()/1000) : 0, preimage: state.lookupState === "settled" ? state.lookupPreimage : undefined };
            }
            const content = nip44.encrypt(JSON.stringify({ result_type: request.method, result, error }), key);
            publish(finalizeEvent({ kind: 23195, created_at: Math.floor(Date.now()/1000), tags: [["p", event.pubkey], ["e", event.id]], content }, walletKey));
        });
    });
    state.notify = (type) => {
        const pubkey = getPublicKey(clientKey);
        const notification = type === "payment_received" ? incoming() : outgoing;
        const content = nip44.encrypt(JSON.stringify({ notification_type: type, notification }), nip44.getConversationKey(walletKey, pubkey));
        const event = finalizeEvent({ kind: 23197, created_at: Math.floor(Date.now()/1000), tags: [["p", pubkey]], content }, walletKey);
        publishers.forEach((publish) => publish(event));
    };
    page.on("pageerror", (error) => state.errors.push(error.message));
    await page.goto("/help");
    await page.getByRole("navigation", { name: "Connections and help" }).getByRole("button", { name: /^Wallet/ }).click();
    await page.getByLabel("NWC connection string").fill(uri);
    await page.getByRole("button", { name: "Connect NWC wallet", exact: true }).click();
    await expect(page.getByText("Connected: Fixture wallet.", { exact: false })).toBeVisible();
    return { state, sentInvoice, dialog: page.getByRole("dialog") };
}

async function sendReview(page: Page, invoice: string) {
    await page.getByRole("navigation", { name: "Wallet views" }).getByRole("button", { name: "Send", exact: true }).click();
    await page.getByLabel("Invoice or Lightning Address").fill(invoice);
    await page.getByRole("button", { name: "Review payment" }).click();
    await expect(page.getByRole("button", { name: "Send 21 sats" })).toBeVisible();
}

test("balance, budget, filtered history, details and permissions", async ({ context, page }) => {
    const { state, dialog } = await setup(context, page, { historySize: 22 });
    await expect(page.getByTestId("wallet-balance")).toHaveText("100.001 sats");
    await expect(dialog.getByText("Connection budget: 979 sats remaining.")).toBeVisible();
    await dialog.getByRole("button", { name: "Hide balance" }).click();
    await expect(page.getByTestId("wallet-balance")).toHaveText("•••• sats");
    await dialog.getByRole("button", { name: "Show balance" }).click();
    await dialog.getByRole("button", { name: "Load more transactions" }).click();
    await expect.poll(() => state.historyRequests.at(-1)?.offset).toBe(20);
    const filters = dialog.getByLabel("History filters");
    await filters.getByRole("button", { name: "Sent", exact: true }).click();
    const outgoing = dialog.locator("summary").getByText("Fixture outgoing payment", { exact: true });
    await expect(outgoing).toBeVisible();
    await outgoing.click();
    await expect(dialog.getByText("1.001 sats", { exact: true })).toBeVisible();
    await page.getByRole("navigation", { name: "Wallet views" }).getByRole("button", { name: "Settings" }).click();
    await expect(dialog.getByRole("region", { name: "Wallet permissions" })).toContainText("Payment checks");
    expect(state.charges).toBe(0); expect(state.errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await dialog.locator(".wallet-tab .pixel-btn__face").evaluateAll((faces) => faces.every((face) => face.scrollWidth <= face.clientWidth))).toBe(true);
    await page.screenshot({ path: `test-results/wallet-${test.info().project.name}.png`, fullPage: true });
});

test("receiving-only connection preserves access without fabricating zero balance", async ({ context, page }) => {
    const { state, dialog } = await setup(context, page, { methods: ["get_info", "make_invoice"] });
    await expect(page.getByTestId("wallet-balance")).toHaveText("Balance access not granted");
    await expect(dialog.getByText("History access is not granted.", { exact: false })).toBeVisible();
    await page.getByRole("navigation", { name: "Wallet views" }).getByRole("button", { name: "Send", exact: true }).click();
    await expect(dialog.getByText("This connection does not allow sending.", { exact: false })).toBeVisible();
    await dialog.getByRole("button", { name: "Disconnect wallet" }).click();
    await expect(dialog.getByLabel("NWC connection string")).toBeVisible();
    expect(state.methods).toEqual(["get_info"]); expect(state.errors).toEqual([]);
});

test("refresh failure keeps stale balance visible and explains the error", async ({ context, page }) => {
    const { state, dialog } = await setup(context, page);
    await expect(page.getByTestId("wallet-balance")).toHaveText("100.001 sats");
    state.balanceFailure = true;
    await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("may be out of date");
    await expect(page.getByTestId("wallet-balance")).toHaveText("100.001 sats");
});

test("review sends nothing, explicit send pays once and updates balance", async ({ context, page }) => {
    const { state, sentInvoice } = await setup(context, page);
    await sendReview(page, sentInvoice); expect(state.charges).toBe(0);
    await page.getByRole("button", { name: "Send 21 sats" }).click();
    await expect(page.getByText("Payment confirmed.", { exact: true })).toBeVisible();
    await expect(page.getByTestId("wallet-balance")).toHaveText("78.999 sats");
    await page.getByRole("button", { name: "New payment" }).click();
    await page.getByRole("button", { name: "Review payment" }).click();
    await expect(page.getByText("Payment confirmed.", { exact: true })).toBeVisible();
    expect(state.charges).toBe(1); expect(state.errors).toEqual([]);
});

test("Lightning Address resolves an invoice before explicit confirmation", async ({ context, page }) => {
    const { state } = await setup(context, page);
    await page.getByRole("navigation", { name: "Wallet views" }).getByRole("button", { name: "Send", exact: true }).click();
    await page.getByLabel("Invoice or Lightning Address").fill("name@recipient.example");
    await page.getByLabel("Amount (sats)", { exact: true }).fill("21");
    await page.getByRole("button", { name: "Review payment" }).click();
    await expect(page.getByRole("region", { name: "Send payment" })).toContainText("Test recipient");
    expect(state.charges).toBe(0);
    await page.getByRole("button", { name: "Send 21 sats" }).click();
    await expect(page.getByText("Payment confirmed.", { exact: true })).toBeVisible(); expect(state.charges).toBe(1);
});

test("receive creates a usable QR and detects settlement without spending", async ({ context, page }) => {
    const { state } = await setup(context, page, { notifications: true });
    await page.getByRole("navigation", { name: "Wallet views" }).getByRole("button", { name: "Receive", exact: true }).click();
    await page.getByLabel("Receive amount (sats)").fill("42");
    await page.getByLabel("Description (optional)").fill("Invoice from Holoboard");
    await page.getByRole("button", { name: "Create invoice", exact: true }).click();
    await expect(page.getByText("Waiting for payment: 42 sats")).toBeVisible();
    const qr = page.getByRole("img", { name: "Receive invoice QR code" });
    await expect(qr).toBeVisible();
    const png = PNG.sync.read(await qr.screenshot());
    expect(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data.toLowerCase()).toBe(state.receiveInvoice);
    await expect(page.getByRole("link", { name: "Open invoice", exact: true })).toHaveAttribute("href", `lightning:${state.receiveInvoice}`);
    state.received = true; state.balance += 42000; state.notify("payment_received");
    await expect(page.getByText("Payment received: 42 sats")).toBeVisible();
    await expect(page.getByTestId("wallet-balance")).toHaveText("142.001 sats");
    expect(state.charges).toBe(0); expect(state.errors).toEqual([]);
});

test("a lost response stays protected after refresh and status checking never resends", async ({ context, page }) => {
    const { state, sentInvoice } = await setup(context, page, { loseResponse: true });
    await sendReview(page, sentInvoice);
    await page.clock.install();
    await page.getByRole("button", { name: "Send 21 sats" }).click();
    await expect.poll(() => state.charges).toBe(1);
    await page.clock.fastForward(61000);
    await expect(page.getByRole("button", { name: "Check payment status", exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole("navigation", { name: "Connections and help" }).getByRole("button", { name: /^Wallet/ }).click();
    await expect(page.getByText("Connected: Fixture wallet.", { exact: false })).toBeVisible();
    await page.getByRole("navigation", { name: "Wallet views" }).getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("button", { name: "Check payment status", exact: true }).click();
    await expect(page.getByText("Payment confirmed.", { exact: true })).toBeVisible();
    expect(state.charges).toBe(1); expect(state.errors).toEqual([]);
});

async function loseSendResponse(page: Page, invoice: string, charges: () => number) {
    await sendReview(page, invoice); await page.clock.install();
    await page.getByRole("button", { name: "Send 21 sats" }).click();
    await expect.poll(charges).toBe(1); await page.clock.fastForward(61000);
    await expect(page.getByRole("button", { name: "Check payment status", exact: true })).toBeVisible();
}
async function reconnect(page: Page, connection = uri) {
    await page.getByRole("button", { name: "Disconnect wallet", exact: true }).click();
    await page.getByLabel("NWC connection string").fill(connection);
    await page.getByRole("button", { name: "Connect NWC wallet", exact: true }).click();
    await expect(page.getByText("Connected: Fixture wallet.", { exact: false })).toBeVisible();
    await page.getByRole("navigation", { name: "Wallet views" }).getByRole("button", { name: "Send", exact: true }).click();
}

test("switching NWC connections preserves the uncertain hash and original connection", async ({ context, page }) => {
    const { state, sentInvoice } = await setup(context, page, { loseResponse: true });
    await loseSendResponse(page, sentInvoice, () => state.charges);
    const replacement = new URL(uri); replacement.searchParams.set("secret", bytesToHex(generateSecretKey()));
    await reconnect(page, replacement.toString());
    await page.getByLabel("Invoice or Lightning Address").fill(sentInvoice);
    await page.getByRole("button", { name: "Review payment" }).click();
    await expect(page.getByRole("button", { name: "Check payment status", exact: true })).toBeDisabled();
    await expect(page.getByText("Reconnect that connection to check its status.", { exact: false })).toBeVisible();
    expect(state.charges).toBe(1); expect(state.methods).not.toContain("lookup_invoice");
    await reconnect(page);
    await page.getByRole("button", { name: "Check payment status", exact: true }).click();
    await expect(page.getByText("Payment confirmed.", { exact: true })).toBeVisible();
    expect(state.charges).toBe(1); expect(state.errors).toEqual([]);
});

test("lookup-only reconnection restores and checks an uncertain send without payment permission", async ({ context, page }) => {
    const { state, sentInvoice } = await setup(context, page, { loseResponse: true });
    await loseSendResponse(page, sentInvoice, () => state.charges);
    state.permissions = ["get_info", "lookup_invoice"];
    await reconnect(page);
    await expect(page.getByRole("button", { name: "Check payment status", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Check payment status", exact: true }).click();
    await expect(page.getByText("Payment confirmed.", { exact: true })).toBeVisible();
    expect(state.charges).toBe(1); expect(state.methods.filter((method) => method === "lookup_invoice")).toHaveLength(1);
    expect(state.errors).toEqual([]);
});

test("a connection without lookup can review another invoice and retain the protected one after reload", async ({ context, page }) => {
    const { state, sentInvoice } = await setup(context, page, { loseResponse: true, methods: ["get_info", "pay_invoice"] });
    await loseSendResponse(page, sentInvoice, () => state.charges);
    await expect(page.getByRole("button", { name: "Check payment status", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "New payment", exact: true }).click();
    await expect(page.getByLabel("Unresolved payments")).toBeVisible();
    await sendReview(page, walletInvoice({ hash: incomingHash }));
    expect(state.charges).toBe(1);
    await page.reload();
    await page.getByRole("navigation", { name: "Connections and help" }).getByRole("button", { name: /^Wallet/ }).click();
    await expect(page.getByText("Connected: Fixture wallet.", { exact: false })).toBeVisible();
    await page.getByRole("navigation", { name: "Wallet views" }).getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("button", { name: "Review unresolved payment", exact: true }).click();
    await expect(page.getByRole("button", { name: "Check payment status", exact: true })).toBeDisabled();
    expect(state.charges).toBe(1); expect(state.errors).toEqual([]);
});

for (const restoredProof of [null, "ff".repeat(32)]) test(`restored submitted proof ${restoredProof === null ? "missing" : "mismatched"} is checked without resending`, async ({ context, page }) => {
    const { state } = await setup(context, page, { restoredProof, methods: ["get_info", "lookup_invoice"] });
    await page.getByRole("navigation", { name: "Wallet views" }).getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("button", { name: "Review unresolved payment", exact: true }).click();
    await expect(page.getByText("Payment confirmed.", { exact: true })).toHaveCount(0);
    await expect(page.getByText("its proof is not verified", { exact: false })).toBeVisible();
    state.lookupPreimage = "ff".repeat(32);
    await page.getByRole("button", { name: "Check payment status", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByText("Payment confirmed.", { exact: true })).toHaveCount(0);
    state.lookupState = "failed";
    await page.getByRole("button", { name: "Check payment status", exact: true }).click();
    await expect.poll(() => state.methods.filter((method) => method === "lookup_invoice").length).toBe(2);
    await expect(page.getByRole("button", { name: "Check payment status", exact: true })).toBeEnabled();
    await expect(page.getByText("Payment confirmed.", { exact: true })).toHaveCount(0);
    state.lookupState = "settled"; state.lookupPreimage = preimage;
    await page.getByRole("button", { name: "Check payment status", exact: true }).click();
    await expect(page.getByText("Payment confirmed.", { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole("navigation", { name: "Connections and help" }).getByRole("button", { name: /^Wallet/ }).click();
    await expect(page.getByText("Connected: Fixture wallet.", { exact: false })).toBeVisible();
    await page.getByRole("navigation", { name: "Wallet views" }).getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Payment confirmed.", { exact: true })).toBeVisible();
    expect(state.charges).toBe(0); expect(state.errors).toEqual([]);
});

test("QR image input populates a reviewed invoice without sending", async ({ context, page }) => {
    const { state, sentInvoice } = await setup(context, page);
    await page.getByRole("navigation", { name: "Wallet views" }).getByRole("button", { name: "Receive", exact: true }).click();
    await page.getByLabel("Receive amount (sats)").fill("42");
    await page.getByRole("button", { name: "Create invoice", exact: true }).click();
    const qr = page.getByRole("img", { name: "Receive invoice QR code" });
    await expect(qr).toBeVisible(); const buffer = await qr.screenshot();
    const source = PNG.sync.read(buffer);
    expect(jsQR(new Uint8ClampedArray(source.data), source.width, source.height)?.data.toLowerCase()).toBe(state.receiveInvoice);
    await page.getByRole("navigation", { name: "Wallet views" }).getByRole("button", { name: "Send", exact: true }).click();
    await page.getByLabel("Payment QR image").setInputFiles({ name: "payment.png", mimeType: "image/png", buffer });
    await expect(page.getByLabel("Invoice or Lightning Address")).toHaveValue(state.receiveInvoice.toUpperCase());
    await page.getByLabel("Invoice or Lightning Address").fill(sentInvoice);
    await page.getByRole("button", { name: "Review payment" }).click();
    await expect(page.getByRole("button", { name: "Send 21 sats" })).toBeVisible(); expect(state.charges).toBe(0);
});

test("closing the scanner stops a camera stream that arrives late", async ({ context, page }) => {
    await context.addInitScript(() => {
        const camera = { calls: 0, stops: 0, resolve: undefined as ((stream: MediaStream) => void) | undefined };
        Object.assign(window, { testCamera: camera });
        Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
            getUserMedia: () => { camera.calls++; return new Promise<MediaStream>((resolve) => { camera.resolve = resolve; }); },
        } });
    });
    const { state } = await setup(context, page);
    await page.getByRole("navigation", { name: "Wallet views" }).getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("button", { name: "Scan QR", exact: true }).click();
    const cameraState = () => page.evaluate(() => (window as unknown as { testCamera: { calls: number; stops: number } }).testCamera);
    await expect.poll(async () => (await cameraState()).calls).toBe(1);
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.evaluate(() => {
        const camera = (window as unknown as { testCamera: { stops: number; resolve: (stream: MediaStream) => void } }).testCamera;
        camera.resolve({ getTracks: () => [{ stop: () => { camera.stops++; } }] } as unknown as MediaStream);
    });
    await expect.poll(async () => (await cameraState()).stops).toBe(1);
    expect(state.charges).toBe(0); expect(state.errors).toEqual([]);
});
