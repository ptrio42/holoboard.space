import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NWCClient, Nip47GetInfoResponse, Nip47Notification } from "@getalby/sdk/nwc";
import { incomingHash, paymentHash, preimage, walletInvoice } from "../../tests/helpers/walletFixture";
import { sha256Hex } from "./walletInvoice";
import type { PaymentWallet } from "./walletPayment";
let { attachWalletAccount, checkWalletReceive, clearWalletAccount, createWalletReceive, getWalletAccount, loadMoreWalletHistory, prepareWalletSend, refreshWalletAccount, resetWalletSend, reviewWalletSendAttempt, setWalletHistoryFilter, submitWalletSend } = await import("./walletAccount");
let { PaymentRejected, payInvoiceSafely } = await import("./walletPayment");

let storage: Map<string, string>;
const balance = vi.fn(), history = vi.fn(), budget = vi.fn(), make = vi.fn(), lookup = vi.fn(), send = vi.fn(), paymentLookup = vi.fn(), stop = vi.fn();
let notify: (notification: Nip47Notification) => void;
const fake = {
    walletPubkey: "11".repeat(32), publicKey: "22".repeat(32),
    getBalance: balance, listTransactions: history, getBudget: budget, makeInvoice: make, lookupInvoice: lookup,
    subscribeNotifications: vi.fn(async (callback) => { notify = callback; return stop; }),
} as unknown as NWCClient;
const walletId = `nwc:${fake.walletPubkey}:${fake.publicKey}`;
const payer: PaymentWallet = { id: walletId, kind: "nwc", enable: async () => {}, sendPayment: send, lookupPayment: paymentLookup };
const info = (methods: string[], notifications: string[] = []) => ({ methods, notifications }) as Nip47GetInfoResponse;
const tx = (hash = paymentHash) => ({ type: "outgoing", payment_hash: hash, amount: 21000, state: "settled" });
beforeEach(async () => {
    vi.resetModules();
    ({ attachWalletAccount, checkWalletReceive, clearWalletAccount, createWalletReceive, getWalletAccount, loadMoreWalletHistory, prepareWalletSend, refreshWalletAccount, resetWalletSend, reviewWalletSendAttempt, setWalletHistoryFilter, submitWalletSend } = await import("./walletAccount"));
    ({ PaymentRejected, payInvoiceSafely } = await import("./walletPayment"));
    vi.resetAllMocks();
    fake.subscribeNotifications = vi.fn(async (callback) => { notify = callback; return stop; });
    storage = new Map();
    vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    balance.mockResolvedValue({ balance: 100001 }); history.mockResolvedValue({ transactions: [tx()] });
    budget.mockResolvedValue({ used_budget: 21000, total_budget: 100000, renewal_period: "daily" });
    lookup.mockResolvedValue({ ...tx(), preimage });
    send.mockResolvedValue({ preimage, feesPaidMsats: 2 }); paymentLookup.mockResolvedValue({ state: "paid", preimage });
});
afterEach(() => { clearWalletAccount(); vi.unstubAllGlobals(); });

// Use fresh public connection identities so in-memory payment protections stay isolated.
let connection = 0;
function attach(methods: string[], notifications: string[] = []) {
    const client = { ...fake, publicKey: (++connection).toString(16).padStart(64, "0") } as NWCClient;
    attachWalletAccount(client, info(methods, notifications), { ...payer, id: `nwc:${client.walletPubkey}:${client.publicKey}` });
    return client;
}
describe("NWC account data", () => {
    it("only requests granted methods and keeps unavailable balance distinct from zero", async () => {
        attach(["make_invoice"]); await refreshWalletAccount();
        expect(balance).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled(); expect(budget).not.toHaveBeenCalled();
        expect(getWalletAccount().balance).toBeNull();
        attach(["get_balance"]); balance.mockResolvedValueOnce({ balance: 0 }); await refreshWalletAccount();
        // The first request starts on attach; refresh shares that request.
        await refreshWalletAccount();
        expect(getWalletAccount().balance).toBe(0);
    });
    it("reports refresh failures while preserving the last successful balance", async () => {
        attach(["get_balance", "get_budget"]); await refreshWalletAccount();
        expect(getWalletAccount()).toMatchObject({ balance: 100001, budget: { total_budget: 100000 } });
        balance.mockRejectedValueOnce(new Error("offline")); await refreshWalletAccount();
        expect(getWalletAccount().balance).toBe(100001); expect(getWalletAccount().balanceError).toContain("Could not refresh");
    });
    it("ignores an old wallet's late response after switching connections", async () => {
        let resolve!: (value: unknown) => void;
        balance.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
        attach(["get_balance"]); const pending = refreshWalletAccount();
        attach(["make_invoice"]); resolve({ balance: 9000 }); await pending;
        expect(getWalletAccount().balance).toBeNull();
    });
    it("paginates history and requests filters from the wallet", async () => {
        history.mockResolvedValueOnce({ transactions: Array.from({ length: 20 }, (_, index) => tx(index.toString(16).padStart(64, "0"))) });
        attach(["list_transactions"]); await refreshWalletAccount();
        expect(getWalletAccount().hasMore).toBe(true);
        await loadMoreWalletHistory();
        expect(history.mock.calls[1][0]).toMatchObject({ offset: 20, limit: 20, unpaid: true });
        setWalletHistoryFilter("incoming"); await vi.waitFor(() => expect(history).toHaveBeenCalledTimes(3));
        expect(history.mock.calls[2][0]).toMatchObject({ offset: 0, type: "incoming" });
    });
    it("uses notifications to refresh and releases the subscription on disconnect", async () => {
        attach(["get_balance"], ["payment_sent"]); await refreshWalletAccount();
        await vi.waitFor(() => expect(getWalletAccount().notifications).toBe("active"));
        notify({ notification_type: "payment_sent", notification: tx() as never });
        await refreshWalletAccount(); expect(balance).toHaveBeenCalledTimes(2);
        clearWalletAccount(); expect(stop).toHaveBeenCalledTimes(1); expect(getWalletAccount().id).toBe("");
    });
});

describe("wallet sends", () => {
    it("prepares without sending and pays exactly once with a verified proof", async () => {
        attach(["pay_invoice"]); await prepareWalletSend(walletInvoice(), "");
        expect(send).not.toHaveBeenCalled();
        await submitWalletSend(); await submitWalletSend();
        expect(send).toHaveBeenCalledTimes(1);
        expect(getWalletAccount().send).toMatchObject({ attempt: { state: "submitted" }, feesMsats: 2 });
    });
    it("passes an amount only for amountless invoices", async () => {
        attach(["pay_invoice"]); await prepareWalletSend(walletInvoice({ amountMsats: null }), "42"); await submitWalletSend();
        expect(send.mock.calls[0][1]).toBe(42000);
    });
    it("keeps a lost response protected across panel closure and reconnect", async () => {
        const client = attach(["pay_invoice", "lookup_invoice"]);
        await prepareWalletSend(walletInvoice(), "");
        send.mockRejectedValueOnce(new Error("Response lost")); await submitWalletSend();
        expect(getWalletAccount().send?.attempt?.state).toBe("uncertain");
        resetWalletSend(); expect(getWalletAccount().send).toBeNull();
        reviewWalletSendAttempt(paymentHash);
        clearWalletAccount(); attachWalletAccount(client, info(["pay_invoice", "lookup_invoice"]), { ...payer, id: `nwc:${client.walletPubkey}:${client.publicKey}` });
        await submitWalletSend();
        expect(lookup).toHaveBeenCalledWith({ payment_hash: paymentHash }); expect(send).toHaveBeenCalledTimes(1);
        expect(getWalletAccount().send?.attempt?.state).toBe("submitted");
    });
    it("checks confirmed failure separately from a new send", async () => {
        attach(["pay_invoice", "lookup_invoice"]); await prepareWalletSend(walletInvoice(), "");
        send.mockRejectedValueOnce(new Error("Response lost")); await submitWalletSend();
        lookup.mockResolvedValueOnce({ ...tx(), state: "failed" }); await submitWalletSend();
        expect(send).toHaveBeenCalledTimes(1); expect(getWalletAccount().send?.attempt?.state).toBe("unpaid");
        await submitWalletSend(); expect(send).toHaveBeenCalledTimes(2);
    });
    it("does not allow missing lookup results or invalid proofs to trigger another charge", async () => {
        attach(["pay_invoice", "lookup_invoice"]); await prepareWalletSend(walletInvoice(), "");
        send.mockResolvedValueOnce({ preimage: "ff".repeat(32) }); await submitWalletSend();
        lookup.mockRejectedValueOnce(new Error("NOT_FOUND")); await submitWalletSend();
        expect(send).toHaveBeenCalledTimes(1); expect(getWalletAccount().send?.attempt?.state).toBe("uncertain");
    });
    it("blocks the same uncertain invoice after switching connection and keeps its original identity", async () => {
        const original = attach(["pay_invoice", "lookup_invoice"]);
        const originalId = getWalletAccount().id;
        await prepareWalletSend(walletInvoice(), "");
        send.mockRejectedValueOnce(new Error("Response lost")); await submitWalletSend();
        attach(["pay_invoice", "lookup_invoice"]);
        await prepareWalletSend(walletInvoice(), ""); await submitWalletSend();
        expect(send).toHaveBeenCalledTimes(1); expect(lookup).not.toHaveBeenCalled();
        expect(getWalletAccount().send?.attempt).toMatchObject({ state: "uncertain", walletId: originalId });
        expect(getWalletAccount().actionError).toContain("original wallet connection");
        clearWalletAccount(); attachWalletAccount(original, info(["lookup_invoice"]));
        await submitWalletSend();
        expect(lookup).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledTimes(1);
        expect(getWalletAccount().send?.attempt?.state).toBe("submitted");
    });
    it("uses promotion attempts when reviewing the same invoice in the wallet panel", async () => {
        attach(["pay_invoice", "lookup_invoice"]);
        const promotionWallet = { ...payer, id: getWalletAccount().id };
        send.mockRejectedValueOnce(new Error("Response lost"));
        await expect(payInvoiceSafely(promotionWallet, walletInvoice(), paymentHash, undefined, vi.fn())).rejects.toThrow("Response lost");
        await prepareWalletSend(walletInvoice(), ""); await submitWalletSend();
        expect(send).toHaveBeenCalledTimes(1); expect(lookup).toHaveBeenCalledOnce();
        expect(getWalletAccount().send?.attempt?.state).toBe("submitted");
    });
    it("uses panel attempts in promotion instead of sending from a second wallet", async () => {
        attach(["pay_invoice"]); await prepareWalletSend(walletInvoice(), "");
        send.mockRejectedValueOnce(new Error("Response lost")); await submitWalletSend();
        await expect(payInvoiceSafely({ ...payer, id: "other-wallet" }, walletInvoice(), paymentHash, undefined, vi.fn())).rejects.toThrow("original wallet");
        expect(send).toHaveBeenCalledTimes(1); expect(paymentLookup).not.toHaveBeenCalled();
    });
    it("checks an uncertain payment with lookup permission and no payer", async () => {
        const original = attach(["pay_invoice", "lookup_invoice"]);
        await prepareWalletSend(walletInvoice(), ""); send.mockRejectedValueOnce(new Error("Response lost")); await submitWalletSend();
        clearWalletAccount(); attachWalletAccount(original, info(["lookup_invoice"]));
        await submitWalletSend();
        expect(lookup).toHaveBeenCalledWith({ payment_hash: paymentHash }); expect(send).toHaveBeenCalledTimes(1);
        expect(getWalletAccount().send?.attempt?.state).toBe("submitted");
    });
    it("allows another hash without lookup while retaining protection and a recovery entry", async () => {
        attach(["pay_invoice"]); await prepareWalletSend(walletInvoice(), "");
        send.mockRejectedValueOnce(new Error("Response lost")); await submitWalletSend();
        resetWalletSend(); expect(getWalletAccount().send).toBeNull();
        expect(getWalletAccount().pendingSends).toHaveLength(1);
        const otherPreimage = "43".repeat(32);
        const otherHash = await sha256Hex(new Uint8Array(32).fill(0x43));
        send.mockResolvedValueOnce({ preimage: otherPreimage });
        await prepareWalletSend(walletInvoice({ hash: otherHash }), ""); await submitWalletSend();
        expect(send).toHaveBeenCalledTimes(2); expect(getWalletAccount().send?.attempt?.state).toBe("submitted");
        await prepareWalletSend(walletInvoice(), "");
        expect(getWalletAccount().send?.attempt?.state).toBe("uncertain");
        reviewWalletSendAttempt(paymentHash);
        expect(getWalletAccount().send?.paymentHash).toBe(paymentHash);
        expect(lookup).not.toHaveBeenCalled();
    });
    it("can reopen an expired unresolved invoice for lookup after starting a different payment", async () => {
        attach(["pay_invoice", "lookup_invoice"]); await prepareWalletSend(walletInvoice(), "");
        send.mockRejectedValueOnce(new Error("Response lost")); await submitWalletSend(); resetWalletSend();
        const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3601000);
        try {
            reviewWalletSendAttempt(paymentHash); await submitWalletSend();
            expect(getWalletAccount().send?.attempt?.state).toBe("submitted");
            expect(send).toHaveBeenCalledTimes(1); expect(lookup).toHaveBeenCalledOnce();
        } finally { now.mockRestore(); }
    });
    it("allows an explicit rejection to be reviewed again", async () => {
        attach(["pay_invoice"]); await prepareWalletSend(walletInvoice(), "");
        send.mockRejectedValueOnce(new PaymentRejected("Quota exceeded")); await submitWalletSend();
        expect(getWalletAccount().send?.attempt?.state).toBe("unpaid"); resetWalletSend(); expect(getWalletAccount().send).toBeNull();
    });
    it("does not send again when a previously paid invoice is pasted again", async () => {
        attach(["pay_invoice"]); const invoice = walletInvoice();
        await prepareWalletSend(invoice, ""); await submitWalletSend(); resetWalletSend();
        await prepareWalletSend(invoice, ""); await submitWalletSend(); expect(send).toHaveBeenCalledTimes(1);
    });
});

describe("wallet receives", () => {
    it("checks returned invoice details and confirms an incoming settlement", async () => {
        const invoice = walletInvoice({ amountMsats: 42000, hash: incomingHash });
        make.mockResolvedValueOnce({ invoice, payment_hash: incomingHash, type: "incoming", amount: 42000 });
        lookup.mockResolvedValueOnce({ payment_hash: incomingHash, amount: 42000, type: "incoming", state: "settled" });
        attach(["make_invoice", "lookup_invoice"]); await createWalletReceive("42", "Test receive");
        expect(make).toHaveBeenCalledWith({ amount: 42000, description: "Test receive", expiry: 3600 });
        await checkWalletReceive(); expect(getWalletAccount().receive?.state).toBe("settled"); expect(send).not.toHaveBeenCalled();
    });
    it("rejects invoices with a different amount", async () => {
        make.mockResolvedValueOnce({ invoice: walletInvoice(), payment_hash: paymentHash, type: "incoming" });
        attach(["make_invoice"]); await createWalletReceive("42", "");
        expect(getWalletAccount().receive).toBeNull(); expect(getWalletAccount().receiveError).toContain("different payment details");
    });
});
