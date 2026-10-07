import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromotionPayment } from "./PaymentState";

const noteA = "a".repeat(64), noteB = "b".repeat(64);
const makePayment = (note: string, hash: string): PromotionPayment => ({
    note, board: { invoice: `lnbc-${hash}`, paymentHash: hash, noteId: note, amountSats: 168, promotionSats: 168, billboardFeeSats: 0, expiresAt: 2000000000 },
    author: { invoice: `lnbc-author-${hash}`, payment_hash: `author-${hash}`, amount_sats: 42, author: "c".repeat(64), expires_at: 2000000000 },
    tipStatus: "pending", promotionPaid: false, added: 0, authorShare: 20,
});

beforeEach(() => {
    vi.resetModules();
    const stored = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
        get length() { return stored.size; }, key: (index: number) => [...stored.keys()][index] ?? null,
        getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
    });
});
afterEach(() => vi.unstubAllGlobals());

describe("promotion payment records", () => {
    it("opens expired unattempted invoices in editing while keeping uncertain attempts active", async () => {
        const records = await import("./paymentRecords");
        const expired = makePayment(noteA, "expired");
        expired.board.expiresAt = 1; expired.author!.expires_at = 1;
        records.savePayment(expired);
        expect(records.restorePayment(noteA)?.editing).toBe(true);
        records.savePayment({ ...expired, boardAttempt: { state: "uncertain", walletId: "wallet" } });
        expect(records.restorePayment(noteA)?.editing).not.toBe(true);
        expect(records.unfinishedPayments(noteA)).toHaveLength(1);
    });
    it("opens a blank editor without adopting the last note's payment", async () => {
        const records = await import("./paymentRecords");
        records.savePayment(makePayment(noteA, "one"));
        expect(records.restorePayment("")).toBeNull();
        expect(records.restorePayment(noteB)).toBeNull();
        expect(records.unfinishedPayments()).toHaveLength(1);
        expect(records.restorePayment(noteA)?.board.paymentHash).toBe("one");
    });
    it("keeps note-specific payments independent when selecting another note", async () => {
        const records = await import("./paymentRecords");
        records.savePayment({ ...makePayment(noteA, "one"), editing: true, promotionPaid: true });
        records.savePayment(makePayment(noteB, "two"));
        expect(records.restorePayment(noteA)).toMatchObject({ editing: true, promotionPaid: true });
        expect(records.restorePayment(noteB)?.board.paymentHash).toBe("two");
        expect(records.unfinishedPayments(noteA)).toHaveLength(1);
        expect(records.unfinishedPayments(noteB)).toHaveLength(1);
    });
    it("archives invoices before preparing another payment for the same note", async () => {
        const records = await import("./paymentRecords");
        records.savePayment({ ...makePayment(noteA, "old"), promotionPaid: true, boardAttempt: { state: "submitted", walletId: "wallet" } });
        records.savePayment(makePayment(noteA, "new"));
        expect(records.unfinishedPayments(noteA)).toHaveLength(2);
        const old = records.unfinishedPayments(noteA).find((payment) => payment.board.paymentHash === "old")!;
        expect(old).toMatchObject({ editing: true, promotionPaid: true, boardAttempt: { state: "submitted" } });
        records.savePayment({ ...old, editing: false });
        expect(records.restorePayment(noteA)?.board.paymentHash).toBe("old");
        expect(records.unfinishedPayments(noteA)).toHaveLength(2);
    });
    it("keeps late wallet replies with their invoice without changing the current pointer", async () => {
        const records = await import("./paymentRecords");
        records.savePayment(makePayment(noteA, "old"));
        records.savePayment(makePayment(noteA, "new"));
        records.savePayment(makePayment(noteB, "other"));
        const pointer = sessionStorage.getItem("holoboard-last-payment");
        records.updateSavedPayment(noteA, "old", { tipStatus: "confirmed", authorAttempt: { state: "submitted", walletId: "wallet", preimage: "proof" } });
        expect(records.restorePayment(noteA)?.board.paymentHash).toBe("new");
        expect(records.unfinishedPayments(noteA).find((payment) => payment.board.paymentHash === "old")).toMatchObject({ tipStatus: "confirmed", authorAttempt: { preimage: "proof" } });
        expect(sessionStorage.getItem("holoboard-last-payment")).toBe(pointer);
        records.updateSavedPayment(noteA, "missing", { promotionPaid: true });
        expect(records.restorePayment(noteA)?.promotionPaid).toBe(false);
    });
    it("retains archived records across reload and rejects a mismatched note record", async () => {
        let records = await import("./paymentRecords");
        records.savePayment(makePayment(noteA, "old")); records.savePayment(makePayment(noteA, "new"));
        sessionStorage.setItem(records.paymentKey(noteB), JSON.stringify(makePayment(noteA, "wrong")));
        vi.resetModules(); records = await import("./paymentRecords");
        expect(records.unfinishedPayments(noteA).map((payment) => payment.board.paymentHash).sort()).toEqual(["new", "old"]);
        expect(records.restorePayment(noteB)).toBeNull();
        expect(records.restorePayment(noteA)?.board.paymentHash).toBe("new");
    });
    it("keeps old invoices in memory when tab storage is blocked", async () => {
        vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("Blocked"); }, setItem: () => { throw new Error("Blocked"); }, removeItem: () => { throw new Error("Blocked"); }, get length() { throw new Error("Blocked"); } });
        const records = await import("./paymentRecords");
        records.savePayment({ ...makePayment(noteA, "old"), editing: true }); records.savePayment(makePayment(noteA, "new"));
        expect(records.unfinishedPayments(noteA)).toHaveLength(2);
        expect(records.restorePayment(noteA)?.board.paymentHash).toBe("new");
    });
});
