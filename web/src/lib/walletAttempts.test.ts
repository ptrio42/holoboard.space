import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentWallet } from "./walletPayment";

let storage: Map<string, string>;
let ledger: typeof import("./walletAttempts");
let payments: typeof import("./walletPayment");
const wallet = (id: string): PaymentWallet => ({ id, kind: "nwc", enable: async () => {}, sendPayment: vi.fn(async () => ({ preimage: "proof" })) });
beforeEach(async () => {
    vi.resetModules(); storage = new Map();
    vi.stubGlobal("sessionStorage", {
        get length() { return storage.size; }, key: (index: number) => [...storage.keys()][index] ?? null,
        getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value),
    });
    ledger = await import("./walletAttempts"); payments = await import("./walletPayment");
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("shared wallet attempt protection", () => {
    it("restores an uncertain hash after reload and blocks another connection with no caller attempt", async () => {
        const original = wallet("original");
        original.sendPayment = vi.fn(async () => { throw new Error("lost"); });
        await expect(payments.payInvoiceSafely(original, "invoice", "hash", undefined, vi.fn())).rejects.toThrow("lost");
        vi.resetModules(); payments = await import("./walletPayment");
        const replacement = wallet("replacement");
        replacement.lookupPayment = vi.fn(async () => ({ state: "unpaid" as const }));
        await expect(payments.payInvoiceSafely(replacement, "invoice", "hash", undefined, vi.fn())).rejects.toThrow("original wallet");
        expect(replacement.sendPayment).not.toHaveBeenCalled(); expect(replacement.lookupPayment).not.toHaveBeenCalled();
    });
    it("restores protection from older wallet and promotion sessions without erasing them", async () => {
        const old = JSON.stringify({ attempts: { panel: { state: "uncertain", walletId: "original" } }, send: { paymentHash: "panel", invoice: "panel-invoice", amountMsats: 21000 } });
        storage.set("holoboard-wallet-activity:original", old);
        storage.set("holoboard-payment:note", JSON.stringify({ board: { paymentHash: "board", invoice: "board-invoice" }, boardAttempt: { state: "submitted", walletId: "original", preimage: "proof" }, author: { payment_hash: "author", invoice: "author-invoice" }, authorAttempt: { state: "uncertain", walletId: "original" } }));
        expect(ledger.getWalletAttempt("panel")).toMatchObject({ state: "uncertain", walletId: "original" });
        expect(ledger.getWalletAttempt("author")).toMatchObject({ state: "uncertain", walletId: "original" });
        expect(ledger.getWalletAttempt("board")).toMatchObject({ state: "submitted" });
        expect(storage.get("holoboard-wallet-activity:original")).toBe(old);
    });
    it("keeps a separately saved submitted proof if the shared storage write was incomplete", () => {
        storage.set("holoboard-wallet-attempts", JSON.stringify({ hash: { attempt: { state: "uncertain", walletId: "original" } } }));
        storage.set("holoboard-payment:note", JSON.stringify({ author: { payment_hash: "hash", invoice: "invoice" }, authorAttempt: { state: "submitted", walletId: "original", preimage: "proof" } }));
        expect(ledger.getWalletAttempt("hash")).toMatchObject({ state: "submitted", preimage: "proof" });
    });
    it("blocks concurrent sends between flows and ignores a stale unpaid caller state", async () => {
        let complete!: (value: { preimage: string }) => void;
        const payer = wallet("original");
        payer.sendPayment = vi.fn(() => new Promise<{ preimage: string }>((resolve) => { complete = resolve; }));
        const first = payments.payInvoiceSafely(payer, "invoice", "hash", undefined, vi.fn());
        await expect(payments.payInvoiceSafely(wallet("replacement"), "invoice", "hash", { state: "unpaid", walletId: "replacement" }, vi.fn())).rejects.toThrow("in progress");
        expect(ledger.acknowledgeWalletFailure("hash", { state: "uncertain", walletId: payer.id }).state).toBe("uncertain");
        complete({ preimage: "proof" }); await first;
        const replacement = wallet("replacement");
        await payments.payInvoiceSafely(replacement, "invoice", "hash", { state: "unpaid", walletId: replacement.id }, vi.fn());
        expect(replacement.sendPayment).not.toHaveBeenCalled();
        expect(ledger.getWalletAttempt("hash")?.walletId).toBe("original");
    });
    it("keeps protection across connections in memory when storage is blocked", async () => {
        vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
        const original = wallet("original"); original.sendPayment = vi.fn(async () => { throw new Error("lost"); });
        await expect(payments.payInvoiceSafely(original, "invoice", "hash", undefined, vi.fn())).rejects.toThrow("lost");
        const replacement = wallet("replacement");
        await expect(payments.payInvoiceSafely(replacement, "invoice", "hash", undefined, vi.fn())).rejects.toThrow("original wallet");
        expect(replacement.sendPayment).not.toHaveBeenCalled(); expect(ledger.walletAttemptsArePersistent()).toBe(false);
    });
    it("propagates an explicit failure acknowledgement to other flows but never releases submitted payments", () => {
        ledger.saveWalletAttempt("hash", { state: "uncertain", walletId: "original" }, "invoice");
        const old = ledger.getWalletAttempt("hash")!;
        expect(ledger.acknowledgeWalletFailure("hash", old).state).toBe("unpaid");
        expect(ledger.getWalletAttempt("hash", old)?.state).toBe("unpaid");
        ledger.saveWalletAttempt("hash", { state: "submitted", walletId: "original", preimage: "proof" });
        expect(ledger.acknowledgeWalletFailure("hash", old).state).toBe("submitted");
    });
});
