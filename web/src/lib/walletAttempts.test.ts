import { recovery, setupWalletRecovery } from "../../tests/helpers/walletRecoveryUnit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paymentHash, preimage } from "../../tests/helpers/walletFixture";
import type { PaymentWallet } from "./walletPayment";

let storage: Map<string, string>;
let ledger: typeof import("./walletAttempts");
let payments: typeof import("./walletPayment");
const wallet = (id: string): PaymentWallet => ({ id, kind: "nwc", enable: async () => {}, sendPayment: vi.fn(async () => ({ preimage })) });
beforeEach(async () => {
    setupWalletRecovery();
    vi.resetModules(); storage = new Map();
    vi.stubGlobal("sessionStorage", {
        get length() { return storage.size; }, key: (index: number) => [...storage.keys()][index] ?? null,
        getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value),
    });
    ledger = await import("./walletAttempts"); payments = await import("./walletPayment");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("shared wallet attempt protection", () => {
    it("restores an uncertain hash after reload and blocks another connection with no caller attempt", async () => {
        const original = wallet("original");
        original.sendPayment = vi.fn(async () => { throw new Error("lost"); });
        await expect(payments.payInvoiceSafely(original, "invoice", paymentHash, undefined, vi.fn())).rejects.toThrow("lost");
        vi.resetModules(); payments = await import("./walletPayment");
        const replacement = wallet("replacement");
        replacement.lookupPayment = vi.fn(async () => ({ state: "unpaid" as const }));
        await expect(payments.payInvoiceSafely(replacement, "invoice", paymentHash, undefined, vi.fn())).rejects.toThrow("original wallet");
        expect(replacement.sendPayment).not.toHaveBeenCalled(); expect(replacement.lookupPayment).not.toHaveBeenCalled();
    });
    it("restores protection from older wallet and promotion sessions without erasing them", async () => {
        const old = JSON.stringify({ attempts: { ["a1".repeat(32)]: { state: "uncertain", walletId: "original" } }, send: { paymentHash: "a1".repeat(32), invoice: "panel-invoice", amountMsats: 21000 } });
        storage.set("holoboard-wallet-activity:original", old);
        storage.set("holoboard-payment:note", JSON.stringify({ board: { paymentHash: "b1".repeat(32), invoice: "board-invoice" }, boardAttempt: { state: "submitted", walletId: "original", preimage }, author: { payment_hash: "c1".repeat(32), invoice: "author-invoice" }, authorAttempt: { state: "uncertain", walletId: "original" } }));
        expect(ledger.getWalletAttempt("a1".repeat(32))).toMatchObject({ state: "uncertain", walletId: "original" });
        expect(ledger.getWalletAttempt("c1".repeat(32))).toMatchObject({ state: "uncertain", walletId: "original" });
        expect(ledger.getWalletAttempt("b1".repeat(32))).toMatchObject({ state: "submitted" });
        expect(storage.get("holoboard-wallet-activity:original")).toBe(old);
    });
    it("durably imports legacy uncertain hash barriers without backend provenance", async () => {
        storage.set("holoboard-wallet-attempts", JSON.stringify({ [paymentHash]: { attempt: { state: "uncertain", walletId: "original" }, invoice: "invoice" } }));
        await ledger.initializeWalletAttempts();
        expect(recovery.records.get(paymentHash)).toMatchObject({ attempt: { state: "uncertain", walletId: "original" } });
        storage.clear(); vi.resetModules();
        const fresh = await import("./walletPayment");
        const payer = wallet("replacement");
        await expect(fresh.payInvoiceSafely(payer, "invoice", paymentHash, undefined, vi.fn())).rejects.toThrow("original wallet");
        expect(payer.sendPayment).not.toHaveBeenCalled();
    });
    it("keeps a separately saved submitted proof if the shared storage write was incomplete", () => {
        storage.set("holoboard-wallet-attempts", JSON.stringify({ [paymentHash]: { attempt: { state: "uncertain", walletId: "original" } } }));
        storage.set("holoboard-payment:note", JSON.stringify({ author: { payment_hash: paymentHash, invoice: "invoice" }, authorAttempt: { state: "submitted", walletId: "original", preimage } }));
        expect(ledger.getWalletAttempt(paymentHash)).toMatchObject({ state: "submitted", preimage });
    });
    it("blocks concurrent sends between flows and ignores a stale unpaid caller state", async () => {
        let complete!: (value: { preimage: string }) => void;
        const payer = wallet("original");
        payer.sendPayment = vi.fn(() => new Promise<{ preimage: string }>((resolve) => { complete = resolve; }));
        const first = payments.payInvoiceSafely(payer, "invoice", paymentHash, undefined, vi.fn());
        await expect(payments.payInvoiceSafely(wallet("replacement"), "invoice", paymentHash, { state: "unpaid", walletId: "replacement" }, vi.fn())).rejects.toThrow("in progress");
        await expect(ledger.acknowledgeWalletFailure(paymentHash, { state: "uncertain", walletId: payer.id })).rejects.toThrow("in progress");
        await vi.waitFor(() => expect(payer.sendPayment).toHaveBeenCalledOnce());
        complete({ preimage }); await first;
        const replacement = wallet("replacement");
        await payments.payInvoiceSafely(replacement, "invoice", paymentHash, { state: "unpaid", walletId: replacement.id }, vi.fn());
        expect(replacement.sendPayment).not.toHaveBeenCalled();
        expect(ledger.getWalletAttempt(paymentHash)?.walletId).toBe("original");
    });
    it("blocks sending when storage cannot establish the original hash barriers", async () => {
        vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); } });
        const original = wallet("original");
        await expect(payments.payInvoiceSafely(original, "invoice", paymentHash, undefined, vi.fn())).rejects.toThrow("cannot be read safely");
        expect(original.sendPayment).not.toHaveBeenCalled();
    });
    it("keeps failed local submitted writes stronger than a durable uncertain record", async () => {
        await ledger.saveWalletAttempt(paymentHash, { state: "uncertain", walletId: "original" }, "invoice");
        recovery.fail = true;
        await expect(ledger.saveWalletAttempt(paymentHash, { state: "submitted", walletId: "original", preimage })).rejects.toThrow("storage");
        recovery.fail = false;
        const replacement = wallet("replacement");
        await payments.payInvoiceSafely(replacement, "invoice", paymentHash, undefined, vi.fn());
        expect(replacement.sendPayment).not.toHaveBeenCalled();
    });
    it("refreshes submitted proof from external writes without trusting an old invalid snapshot", async () => {
        let focus!: () => void;
        vi.stubGlobal("window", { addEventListener: (_type: string, listener: () => void) => { focus = listener; } });
        vi.stubGlobal("BroadcastChannel", undefined);
        vi.resetModules(); ledger = await import("./walletAttempts");
        recovery.records.set(paymentHash, { attempt: { state: "submitted", walletId: "original", preimage: "ff".repeat(32) }, revision: 1 });
        await ledger.initializeWalletAttempts();
        expect(ledger.walletAttemptIsConfirmed(paymentHash, ledger.getWalletAttempt(paymentHash))).toBe(false);
        recovery.records.set(paymentHash, { attempt: { state: "submitted", walletId: "original", preimage }, revision: 2 });
        focus();
        await vi.waitFor(() => expect(ledger.getWalletAttempt(paymentHash)?.preimage).toBe(preimage));
        expect(ledger.walletAttemptIsConfirmed(paymentHash, ledger.getWalletAttempt(paymentHash))).toBe(true);
        recovery.records.set(paymentHash, { attempt: { state: "unpaid", walletId: "replacement" }, revision: 1 });
        focus(); await Promise.resolve(); await Promise.resolve();
        expect(ledger.getWalletAttempt(paymentHash)).toMatchObject({ state: "submitted", walletId: "original", preimage });
    });
    it("external unpaid snapshots cannot discard caller uncertainty without a known revision", async () => {
        let focus!: () => void;
        vi.stubGlobal("window", { addEventListener: (_type: string, listener: () => void) => { focus = listener; } });
        vi.stubGlobal("BroadcastChannel", undefined);
        vi.resetModules(); ledger = await import("./walletAttempts");
        recovery.records.set(paymentHash, { attempt: { state: "unpaid", walletId: "original" }, revision: 1 });
        await ledger.initializeWalletAttempts();
        expect(ledger.getWalletAttempt(paymentHash, { state: "uncertain", walletId: "original" })?.state).toBe("uncertain");
        recovery.records.set(paymentHash, { attempt: { state: "unpaid", walletId: "original" }, revision: 3 });
        focus(); await Promise.resolve(); await Promise.resolve();
        expect(ledger.getWalletAttempt(paymentHash)?.state).toBe("uncertain");
        recovery.records.set(paymentHash, { attempt: { state: "unpaid", walletId: "original" }, revision: 4 });
        focus(); await Promise.resolve(); await Promise.resolve();
        expect(ledger.getWalletAttempt(paymentHash)?.state).toBe("uncertain");
    });
    it.each(["acknowledgement", "original-wallet lookup"])("a delayed different-hash proof cannot revive uncertainty after %s", async resolution => {
        let focus!: () => void;
        vi.stubGlobal("window", { addEventListener: (_type: string, listener: () => void) => { focus = listener; } });
        vi.stubGlobal("BroadcastChannel", undefined);
        vi.resetModules(); ledger = await import("./walletAttempts"); payments = await import("./walletPayment");
        await ledger.initializeWalletAttempts();
        await ledger.saveWalletAttempt(paymentHash, { state: "uncertain", walletId: "original" }, "invoice");
        const previous = ledger.getWalletAttempt(paymentHash)!;
        const invoice = await import("./walletInvoice");
        const otherPreimage = "13".repeat(32);
        const otherHash = await invoice.sha256Hex(new Uint8Array(32).fill(0x13));
        const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
        let releaseProof!: () => void, proofStarted!: () => void;
        const paused = new Promise<void>(resolve => { proofStarted = resolve; });
        const proofGate = new Promise<void>(resolve => { releaseProof = resolve; });
        vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, bytes) => {
            if (bytes instanceof Uint8Array && bytes[0] === 0x13) { proofStarted(); await proofGate; }
            return nativeDigest(algorithm, bytes);
        });
        const targetSnapshot = structuredClone(recovery.records.get(paymentHash));
        recovery.records.clear();
        recovery.records.set(otherHash, { attempt: { state: "submitted", walletId: "another", preimage: otherPreimage }, revision: 1 });
        recovery.records.set(paymentHash, targetSnapshot);
        focus(); await paused;
        if (resolution === "acknowledgement") await ledger.acknowledgeWalletFailure(paymentHash, previous);
        else {
            const payer = { ...wallet("original"), lookupPayment: vi.fn(async () => ({ state: "unpaid" as const })) };
            await expect(payments.payInvoiceSafely(payer, "invoice", paymentHash, previous, vi.fn(), 1)).rejects.toThrow("expired");
            expect(payer.sendPayment).not.toHaveBeenCalled();
        }
        const resolved = structuredClone(recovery.records.get(paymentHash));
        expect(resolved).toMatchObject({ attempt: { state: "unpaid" } });
        expect(ledger.getWalletAttempt(paymentHash)?.state).toBe("unpaid");
        releaseProof();
        expect(await ledger.verifyWalletPaymentProof(otherHash, otherPreimage)).toBe(true);
        expect(ledger.getWalletAttempt(paymentHash)?.state).toBe("unpaid");
        expect(recovery.records.get(paymentHash)).toEqual(resolved);
        await ledger.withWalletAttempt(paymentHash, undefined, undefined, undefined, async locked => {
            expect(locked.attempt?.state).toBe("unpaid");
        });
        expect(recovery.records.get(paymentHash)).toMatchObject({ attempt: { state: "unpaid" } });
    });
    it("an older valid preimage remains protective after a newer unpaid snapshot", async () => {
        let focus!: () => void;
        vi.stubGlobal("window", { addEventListener: (_type: string, listener: () => void) => { focus = listener; } });
        vi.stubGlobal("BroadcastChannel", undefined);
        vi.resetModules(); ledger = await import("./walletAttempts"); payments = await import("./walletPayment");
        recovery.records.set(paymentHash, { attempt: { state: "unpaid", walletId: "original" }, revision: 5 });
        await ledger.initializeWalletAttempts();
        const { IndexedPaymentRecoveryStore } = await import("./paymentRecoveryStore");
        vi.spyOn(IndexedPaymentRecoveryStore.prototype, "readWalletAttempts").mockResolvedValueOnce(new Map([
            [paymentHash, { attempt: { state: "submitted", walletId: "original", preimage }, revision: 1 }],
        ]));
        focus();
        await vi.waitFor(() => expect(ledger.getWalletAttempt(paymentHash)?.state).toBe("submitted"));
        const payer = wallet("replacement");
        await expect(payments.payInvoiceSafely(payer, "invoice", paymentHash, undefined, vi.fn())).resolves.toEqual({ preimage });
        expect(payer.sendPayment).not.toHaveBeenCalled();
    });
    it("keeps the external-store snapshot stable when a caller repeats unchanged uncertainty", async () => {
        await ledger.initializeWalletAttempts();
        const previous = { state: "uncertain" as const, walletId: "original" };
        ledger.getWalletAttempt(paymentHash, previous);
        const before = ledger.getWalletAttemptsSnapshot();
        ledger.getWalletAttempt(paymentHash, previous);
        ledger.getWalletAttempt(paymentHash, previous);
        expect(ledger.getWalletAttemptsSnapshot()).toBe(before);
    });
    it("propagates an explicit failure acknowledgement to other flows but never releases submitted payments", async () => {
        await ledger.saveWalletAttempt(paymentHash, { state: "uncertain", walletId: "original" }, "invoice");
        const old = ledger.getWalletAttempt(paymentHash)!;
        expect((await ledger.acknowledgeWalletFailure(paymentHash, old)).state).toBe("unpaid");
        expect(ledger.getWalletAttempt(paymentHash, old)?.state).toBe("unpaid");
        await ledger.saveWalletAttempt(paymentHash, { state: "submitted", walletId: "original", preimage });
        expect((await ledger.acknowledgeWalletFailure(paymentHash, old)).state).toBe("submitted");
    });
});
