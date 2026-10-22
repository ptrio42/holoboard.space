import { recovery, setupWalletRecovery } from "../../tests/helpers/walletRecoveryUnit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { paymentHash, preimage } from "../../tests/helpers/walletFixture";
import type { PaymentWallet, WalletAttempt } from "./walletPayment";
let { canPayOrCheckInvoice, PaymentRejected, payInvoiceSafely } = await import("./walletPayment");
beforeEach(async () => {
    setupWalletRecovery();
    vi.resetModules();
    ({ canPayOrCheckInvoice, PaymentRejected, payInvoiceSafely } = await import("./walletPayment"));
});

function wallet(overrides: Partial<PaymentWallet> = {}): PaymentWallet {
    return { id: "wallet-a", kind: "nwc", enable: async () => {}, sendPayment: vi.fn(async () => ({ preimage })), ...overrides };
}
describe("wallet payment recovery", () => {
    it.each([undefined, "uncertain", "submitted"] as const)("never sends or looks up a mock invoice with saved state %s", async (state) => {
        const payer = wallet({ lookupPayment: vi.fn(async () => ({ state: "unknown" as const })) });
        const save = vi.fn();
        const previous = state ? { state, walletId: payer.id } : undefined;
        await expect(payInvoiceSafely(payer, "LNBC21...MOCK_INVOICE", paymentHash, previous, save)).rejects.toThrow("test invoices");
        expect(payer.sendPayment).not.toHaveBeenCalled();
        expect(payer.lookupPayment).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
    });
    it("waits for a committed uncertain record before sending", async () => {
        let commit!: () => void;
        recovery.pause = new Promise(resolve => { commit = resolve; });
        const payer = wallet();
        const payment = payInvoiceSafely(payer, "invoice", paymentHash, undefined, vi.fn());
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(payer.sendPayment).not.toHaveBeenCalled();
        commit(); await payment;
        expect(payer.sendPayment).toHaveBeenCalledOnce();
    });
    it("never sends when the attempt transaction fails", async () => {
        recovery.fail = true;
        const payer = wallet();
        await expect(payInvoiceSafely(payer, "invoice", paymentHash, undefined, vi.fn())).rejects.toThrow("storage");
        expect(payer.sendPayment).not.toHaveBeenCalled();
    });
    it("never sends without cross-tab coordination", async () => {
        vi.stubGlobal("navigator", {});
        const payer = wallet();
        await expect(payInvoiceSafely(payer, "invoice", paymentHash, undefined, vi.fn())).rejects.toThrow("coordination");
        expect(payer.sendPayment).not.toHaveBeenCalled();
    });
    it("allows original-wallet lookup without coordination but cannot release uncertainty or send", async () => {
        vi.stubGlobal("navigator", {});
        const payer = wallet({ lookupPayment: vi.fn(async () => ({ state: "unpaid" as const })) });
        await expect(payInvoiceSafely(payer, "invoice", paymentHash, { state: "uncertain", walletId: payer.id }, vi.fn())).rejects.toThrow("coordination");
        expect(payer.lookupPayment).toHaveBeenCalledExactlyOnceWith(paymentHash);
        expect(payer.sendPayment).not.toHaveBeenCalled();
    });
    it("blocks an unknown durable state rather than treating it as absent", async () => {
        recovery.records.set(paymentHash, { attempt: { state: "future", walletId: "original" } });
        const payer = wallet();
        await expect(payInvoiceSafely(payer, "invoice", paymentHash, undefined, vi.fn())).rejects.toThrow("stored");
        expect(payer.sendPayment).not.toHaveBeenCalled();
    });
    it("awaits the caller save and does not send after its action ends", async () => {
        let finish!: () => void;
        let active = true;
        const saved = new Promise<void>(resolve => { finish = resolve; });
        const payer = wallet();
        const payment = payInvoiceSafely(payer, "invoice", paymentHash, undefined, async () => saved, Infinity, undefined, () => active);
        const rejected = expect(payment).rejects.toThrow("action ended");
        await vi.waitFor(() => expect(recovery.records.get(paymentHash)).toMatchObject({ attempt: { state: "uncertain", walletId: payer.id } }));
        expect(payer.sendPayment).not.toHaveBeenCalled();
        active = false; finish(); await rejected;
        expect(payer.sendPayment).not.toHaveBeenCalled();
    });
    it("awaits submitted proof persistence before reporting success", async () => {
        const payer = wallet({ sendPayment: vi.fn(async () => {
            recovery.fail = true;
            return { preimage };
        }) });
        await expect(payInvoiceSafely(payer, "invoice", paymentHash, undefined, vi.fn())).rejects.toThrow("storage");
        expect(recovery.records.get(paymentHash)).toMatchObject({ attempt: { state: "uncertain" } });
        const ledger = await import("./walletAttempts");
        expect(ledger.getWalletAttempt(paymentHash)).toMatchObject({ state: "submitted", preimage });
        recovery.fail = false;
        const other = wallet({ id: "replacement" });
        await payInvoiceSafely(other, "invoice", paymentHash, undefined, vi.fn());
        expect(other.sendPayment).not.toHaveBeenCalled();
    });
    it("does not trust a persisted proofVerified flag", async () => {
        recovery.records.set(paymentHash, { attempt: { state: "submitted", walletId: "original", preimage: "ff".repeat(32), proofVerified: true } });
        const payer = wallet();
        await expect(payInvoiceSafely(payer, "invoice", paymentHash, undefined, vi.fn())).rejects.toThrow("proof is not verified");
        expect(payer.sendPayment).not.toHaveBeenCalled();
    });
    it("retains a verified caller proof over an older invalid submitted snapshot", async () => {
        recovery.records.set(paymentHash, { attempt: { state: "submitted", walletId: "original", preimage: "ff".repeat(32) }, revision: 3 });
        const payer = wallet();
        await expect(payInvoiceSafely(payer, "invoice", paymentHash, { state: "submitted", walletId: "original", preimage }, vi.fn())).resolves.toEqual({ preimage });
        expect(payer.sendPayment).not.toHaveBeenCalled();
    });
    it("a submitted proof preserves the original unresolved wallet identity", async () => {
        recovery.records.set(paymentHash, { attempt: { state: "uncertain", walletId: "original" }, revision: 3 });
        const payer = wallet();
        await payInvoiceSafely(payer, "invoice", paymentHash, { state: "submitted", walletId: "different", preimage }, vi.fn());
        expect(recovery.records.get(paymentHash)).toMatchObject({ attempt: { state: "submitted", walletId: "original", preimage } });
        expect(payer.sendPayment).not.toHaveBeenCalled();
    });
    it("does not discard unknown caller uncertainty when the cache contains unpaid", async () => {
        recovery.records.set(paymentHash, { attempt: { state: "unpaid", walletId: "original" }, revision: 3 });
        const ledger = await import("./walletAttempts");
        await ledger.initializeWalletAttempts();
        recovery.records.set(paymentHash, { attempt: { state: "unpaid", walletId: "original" }, revision: 5 });
        const payer = wallet();
        await expect(payInvoiceSafely(payer, "invoice", paymentHash, { state: "uncertain", walletId: "original" }, vi.fn())).rejects.toThrow("original wallet");
        expect(payer.sendPayment).not.toHaveBeenCalled();
    });
    it("a known stale caller snapshot does not undo a committed original-wallet failure", async () => {
        const previous: WalletAttempt = { state: "uncertain", walletId: "wallet-a" };
        const payer = wallet({ lookupPayment: vi.fn(async () => ({ state: "unpaid" as const })) });
        await expect(payInvoiceSafely(payer, "invoice", paymentHash, previous, vi.fn(), 1)).rejects.toThrow("expired");
        await payInvoiceSafely(payer, "invoice", paymentHash, previous, vi.fn());
        expect(payer.lookupPayment).toHaveBeenCalledTimes(1);
        expect(payer.sendPayment).toHaveBeenCalledOnce();
    });
    it("records uncertainty before sending and retains the wallet proof", async () => {
        const saved: WalletAttempt[] = [];
        const payer = wallet({ sendPayment: vi.fn(async () => {
            expect(saved).toEqual([{ state: "uncertain", walletId: "wallet-a" }]);
            return { preimage };
        }) });
        await payInvoiceSafely(payer, "invoice", paymentHash, undefined, (attempt) => saved.push(attempt));
        expect(saved.at(-1)).toEqual({ state: "submitted", walletId: "wallet-a", preimage });
    });
    it.each([undefined, "bad", "ff".repeat(32)])("never stores submitted after sending with invalid proof %s", async (badProof) => {
        const payer = wallet({ sendPayment: vi.fn(async () => ({ preimage: badProof })) });
        const save = vi.fn();
        await expect(payInvoiceSafely(payer, "invoice", paymentHash, undefined, save)).rejects.toThrow("valid payment proof");
        expect(save).toHaveBeenCalledExactlyOnceWith({ state: "uncertain", walletId: payer.id });
        const { getWalletAttempt } = await import("./walletAttempts");
        expect(getWalletAttempt(paymentHash)?.state).toBe("uncertain");
        payer.lookupPayment = vi.fn(async () => ({ state: "paid" as const, preimage: badProof }));
        await expect(payInvoiceSafely(payer, "invoice", paymentHash, undefined, save)).rejects.toThrow("valid payment proof");
        expect(payer.sendPayment).toHaveBeenCalledTimes(1);
        expect(getWalletAttempt(paymentHash)?.state).toBe("uncertain");
    });
    it.each([undefined, "ff".repeat(32)])("recovers a previously submitted invalid proof %s without sending", async (badProof) => {
        const payer = wallet({ lookupPayment: vi.fn(async () => ({ state: "paid" as const, preimage })) });
        const save = vi.fn();
        const previous: WalletAttempt = { state: "submitted", walletId: payer.id, preimage: badProof };
        await expect(payInvoiceSafely(payer, "invoice", paymentHash, previous, save)).resolves.toEqual({ preimage });
        expect(payer.sendPayment).not.toHaveBeenCalled(); expect(payer.lookupPayment).toHaveBeenCalledOnce();
        expect(save).toHaveBeenCalledWith({ state: "submitted", walletId: payer.id, preimage });
    });
    it("keeps a timeout uncertain and blocks a retry without wallet status", async () => {
        const save = vi.fn();
        const payer = wallet({ sendPayment: vi.fn(async () => { throw new Error("timeout"); }) });
        await expect(payInvoiceSafely(payer, "invoice", paymentHash, undefined, save)).rejects.toThrow("timeout");
        expect(save).toHaveBeenCalledExactlyOnceWith({ state: "uncertain", walletId: "wallet-a" });
        await expect(payInvoiceSafely(payer, "invoice", paymentHash, save.mock.calls[0][0], save)).rejects.toThrow("uncertain");
        expect(payer.sendPayment).toHaveBeenCalledTimes(1);
    });
    it("recovers a settled payment without sending another payment", async () => {
        const payer = wallet({ lookupPayment: vi.fn(async () => ({ state: "paid" as const, preimage })) });
        const save = vi.fn();
        expect(await payInvoiceSafely(payer, "invoice", paymentHash, { state: "uncertain", walletId: payer.id }, save)).toEqual({ preimage });
        expect(payer.sendPayment).not.toHaveBeenCalled();
        expect(save).toHaveBeenCalledWith({ state: "submitted", walletId: payer.id, preimage });
    });
    it.each(["pending", "unknown"] as const)("blocks another payment when lookup returns %s", async (state) => {
        const payer = wallet({ lookupPayment: vi.fn(async () => ({ state })) });
        await expect(payInvoiceSafely(payer, "invoice", paymentHash, { state: "uncertain", walletId: payer.id }, vi.fn())).rejects.toThrow("not confirmed");
        expect(payer.sendPayment).not.toHaveBeenCalled();
    });
    it("allows retry when the original wallet confirms failure", async () => {
        const payer = wallet({ lookupPayment: vi.fn(async () => ({ state: "unpaid" as const })) });
        await payInvoiceSafely(payer, "invoice", paymentHash, { state: "uncertain", walletId: payer.id }, vi.fn());
        expect(payer.sendPayment).toHaveBeenCalledExactlyOnceWith("invoice");
    });
    it.each([1, Infinity])("does not use a different wallet to resolve uncertainty (expiry %s)", async (expiresAt) => {
        const payer = wallet({ lookupPayment: vi.fn(async () => ({ state: "unpaid" as const })) });
        const save = vi.fn();
        await expect(payInvoiceSafely(payer, "invoice", paymentHash, { state: "uncertain", walletId: "wallet-b" }, save, expiresAt)).rejects.toThrow("original wallet");
        expect(payer.lookupPayment).not.toHaveBeenCalled();
        expect(payer.sendPayment).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
    });
    it("allows retry after an explicit wallet rejection", async () => {
        const payer = wallet({ sendPayment: vi.fn(async () => { throw new PaymentRejected("quota"); }) });
        const save = vi.fn();
        await expect(payInvoiceSafely(payer, "invoice", paymentHash, undefined, save)).rejects.toThrow("quota");
        expect(save).toHaveBeenLastCalledWith({ state: "unpaid", walletId: payer.id });
    });
    it("reuses a reported payment and recovers missing proof without sending", async () => {
        const payer = wallet({ lookupPayment: vi.fn(async () => ({ state: "paid" as const, preimage })) });
        expect(await payInvoiceSafely(payer, "invoice", paymentHash, { state: "submitted", walletId: payer.id }, vi.fn())).toEqual({ preimage });
        expect(payer.sendPayment).not.toHaveBeenCalled();
        expect(await payInvoiceSafely(payer, "invoice", paymentHash, { state: "submitted", walletId: payer.id, preimage: "ff".repeat(32) }, vi.fn())).toEqual({ preimage });
        expect(payer.lookupPayment).toHaveBeenCalledTimes(1);
    });
    it.each([undefined, "unpaid"] as const)("never sends an expired invoice with previous state %s", async (state) => {
        const payer = wallet();
        const previous = state ? { state, walletId: payer.id } : undefined;
        const save = vi.fn();
        expect(canPayOrCheckInvoice(payer, 1, previous)).toBe(false);
        await expect(payInvoiceSafely(payer, "expired", paymentHash, previous, save, 1)).rejects.toThrow("expired");
        expect(payer.sendPayment).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    });
    it.each(["uncertain", "submitted"] as const)("recovers proof after expiry for a %s attempt", async (state) => {
        const payer = wallet({ lookupPayment: vi.fn(async () => ({ state: "paid" as const, preimage })) });
        const previous = { state, walletId: payer.id };
        const save = vi.fn();
        expect(canPayOrCheckInvoice(payer, 1, previous)).toBe(true);
        expect(await payInvoiceSafely(payer, "expired", paymentHash, previous, save, 1)).toEqual({ preimage });
        expect(save).toHaveBeenCalledExactlyOnceWith({ state: "submitted", walletId: payer.id, preimage });
        expect(payer.sendPayment).not.toHaveBeenCalled();
    });
    it.each(["pending", "unknown", "unpaid"] as const)("does not resend an expired uncertain invoice after lookup says %s", async (state) => {
        const payer = wallet({ lookupPayment: vi.fn(async () => ({ state })) });
        const save = vi.fn();
        await expect(payInvoiceSafely(payer, "expired", paymentHash, { state: "uncertain", walletId: payer.id }, save, 1)).rejects.toThrow();
        expect(payer.lookupPayment).toHaveBeenCalledExactlyOnceWith(paymentHash);
        expect(payer.sendPayment).not.toHaveBeenCalled();
        if (state === "unpaid") expect(save).toHaveBeenCalledExactlyOnceWith({ state: "unpaid", walletId: payer.id });
        else expect(save).not.toHaveBeenCalled();
    });
    it("rechecks expiry after a slow failed-payment lookup", async () => {
        const expiresAt = Date.now()/1000+1;
        const payer = wallet({ lookupPayment: vi.fn(async () => {
            vi.spyOn(Date, "now").mockReturnValue(expiresAt*1000);
            return { state: "unpaid" as const };
        }) });
        const save = vi.fn();
        try {
            await expect(payInvoiceSafely(payer, "invoice", paymentHash, { state: "uncertain", walletId: payer.id }, save, expiresAt)).rejects.toThrow("expired");
            expect(save).toHaveBeenCalledExactlyOnceWith({ state: "unpaid", walletId: payer.id });
            expect(payer.sendPayment).not.toHaveBeenCalled();
        } finally { vi.restoreAllMocks(); }
    });
    it.each(["unpaid", "pending", "unknown"] as const)("keeps submitted parts protected even when lookup reports %s", async (state) => {
        const payer = wallet({ lookupPayment: vi.fn(async () => ({ state })) });
        const save = vi.fn();
        await expect(payInvoiceSafely(payer, "invoice", paymentHash, { state: "submitted", walletId: payer.id }, save, 1)).rejects.toThrow("proof is not verified");
        expect(payer.sendPayment).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
    });
    it("cannot resolve an expired uncertain attempt without wallet lookup", async () => {
        const payer = wallet();
        const save = vi.fn();
        const previous: WalletAttempt = { state: "uncertain", walletId: payer.id };
        expect(canPayOrCheckInvoice(payer, 1, previous)).toBe(false);
        await expect(payInvoiceSafely(payer, "invoice", paymentHash, previous, save, 1)).rejects.toThrow("original wallet");
        expect(payer.sendPayment).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    });
});
