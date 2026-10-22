import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentRecoverySnapshot } from "../../lib/paymentRecoveryStore";
import type { PromotionPayment } from "./PaymentState";

const fixture = vi.hoisted(() => ({ attempts: new Map<string, unknown>(), records: new Map<string, { payments: Map<string, string>; lastPayment: string | null }>(), fail: false, failAttempts: false, beforeDelete: undefined as (() => Promise<void>) | undefined }));
vi.mock("../../lib/paymentRecoveryStore", () => ({ IndexedPaymentRecoveryStore: class {
    async readWalletAttempts() { if (fixture.failAttempts) throw new Error("Attempt storage blocked"); return new Map(fixture.attempts); }
    async changeWithWalletAttempts(backend: string, update: (snapshot: PaymentRecoverySnapshot, attempts: Map<string, unknown>) => void) {
        if (fixture.beforeDelete) await fixture.beforeDelete();
        if (fixture.failAttempts) throw new Error("Attempt storage blocked");
        return this.change(backend, snapshot => update(snapshot, structuredClone(fixture.attempts)));
    }
    async changeWalletAttempt(hash: string, update: (record: unknown) => unknown) {
        const record = update(fixture.attempts.get(hash));
        if (record !== undefined) fixture.attempts.set(hash, structuredClone(record));
        return structuredClone(record);
    }
    async change(backend: string, update: (snapshot: { payments: Map<string, string>; lastPayment: string | null }) => void) {
        if (fixture.fail) throw new Error("Storage blocked");
        const previous = fixture.records.get(backend);
        const next = { payments: new Map(previous?.payments), lastPayment: previous?.lastPayment ?? null };
        update(next); fixture.records.set(backend, next);
        return { payments: new Map(next.payments), lastPayment: next.lastPayment };
    }
} }));

const noteA = "a".repeat(64), noteB = "b".repeat(64);
const makePayment = (note: string, hash: string): PromotionPayment => ({
    note, board: { invoice: `lnbc-${hash}`, paymentHash: hash, noteId: note, amountSats: 168, promotionSats: 168, billboardFeeSats: 0, expiresAt: 2000000000 },
    author: { invoice: `lnbc-author-${hash}`, payment_hash: `author-${hash}`, amount_sats: 42, author: "c".repeat(64), expires_at: 2000000000 },
    tipStatus: "pending", promotionPaid: false, added: 0, authorShare: 20,
});

beforeEach(() => {
    vi.resetModules(); fixture.records.clear(); fixture.attempts.clear(); fixture.fail = false; fixture.failAttempts = false; fixture.beforeDelete = undefined;
    const active = new Set<string>();
    vi.stubGlobal("navigator", { locks: { request: async (name: string, _options: unknown, action: (lock: object | null) => Promise<unknown>) => {
        if (active.has(name)) return action(null);
        active.add(name);
        try { return await action({}); } finally { active.delete(name); }
    } } });
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
        await records.savePayment(expired);
        expect(records.restorePayment(noteA)?.editing).toBe(true);
        await records.savePayment({ ...expired, boardAttempt: { state: "uncertain", walletId: "wallet" } });
        expect(records.restorePayment(noteA)?.editing).not.toBe(true);
        expect(records.unfinishedPayments(noteA)).toHaveLength(1);
    });
    it("reading an old invoice snapshot cannot revive an explicitly resolved wallet attempt", async () => {
        const { paymentHash } = await import("../../../tests/helpers/walletFixture");
        const records = await import("./paymentRecords");
        const ledger = await import("../../lib/walletAttempts");
        await ledger.initializeWalletAttempts();
        await ledger.saveWalletAttempt(paymentHash, { state: "uncertain", walletId: "original" }, "invoice");
        const previous = ledger.getWalletAttempt(paymentHash)!;
        const payment = { ...makePayment(noteA, paymentHash), author: undefined, boardAttempt: previous };
        payment.board.expiresAt = 1;
        await records.savePayment(payment);
        await ledger.acknowledgeWalletFailure(paymentHash, previous);
        expect(ledger.getWalletAttempt(paymentHash)?.state).toBe("unpaid");
        expect(records.restorePayment(noteA)?.editing).toBe(true);
        expect(ledger.getWalletAttempt(paymentHash)?.state).toBe("unpaid");
        expect(fixture.attempts.get(paymentHash)).toMatchObject({ attempt: { state: "unpaid" } });
    });
    it("opens a blank editor without adopting the last note's payment", async () => {
        const records = await import("./paymentRecords");
        await records.savePayment(makePayment(noteA, "one"));
        expect(records.restorePayment("")).toBeNull();
        expect(records.restorePayment(noteB)).toBeNull();
        expect(records.unfinishedPayments()).toHaveLength(1);
        expect(records.restorePayment(noteA)?.board.paymentHash).toBe("one");
    });
    it("keeps note-specific payments independent when selecting another note", async () => {
        const records = await import("./paymentRecords");
        await records.savePayment({ ...makePayment(noteA, "one"), editing: true, promotionPaid: true });
        await records.savePayment(makePayment(noteB, "two"));
        expect(records.restorePayment(noteA)).toMatchObject({ editing: true, promotionPaid: true });
        expect(records.restorePayment(noteB)?.board.paymentHash).toBe("two");
        expect(records.unfinishedPayments(noteA)).toHaveLength(1);
        expect(records.unfinishedPayments(noteB)).toHaveLength(1);
    });
    it("archives invoices before preparing another payment for the same note", async () => {
        const records = await import("./paymentRecords");
        await records.savePayment({ ...makePayment(noteA, "old"), promotionPaid: true, boardAttempt: { state: "submitted", walletId: "wallet" } });
        await records.savePayment(makePayment(noteA, "new"));
        expect(records.unfinishedPayments(noteA)).toHaveLength(2);
        const old = records.unfinishedPayments(noteA).find((payment) => payment.board.paymentHash === "old")!;
        expect(old).toMatchObject({ editing: true, promotionPaid: true, boardAttempt: { state: "submitted" } });
        await records.savePayment({ ...old, editing: false });
        expect(records.restorePayment(noteA)?.board.paymentHash).toBe("old");
        expect(records.unfinishedPayments(noteA)).toHaveLength(2);
    });
    it("keeps late wallet replies with their invoice without changing the current pointer", async () => {
        const records = await import("./paymentRecords");
        await records.savePayment(makePayment(noteA, "old"));
        await records.savePayment(makePayment(noteA, "new"));
        await records.savePayment(makePayment(noteB, "other"));
        const session = await import("../../lib/paymentSession");
        const pointer = session.readPaymentSession();
        await records.updateSavedPayment(noteA, "old", { tipStatus: "confirmed", authorAttempt: { state: "submitted", walletId: "wallet", preimage: "proof" } }, "author-old");
        expect(records.restorePayment(noteA)?.board.paymentHash).toBe("new");
        expect(records.unfinishedPayments(noteA).find((payment) => payment.board.paymentHash === "old")).toMatchObject({ tipStatus: "confirmed", authorAttempt: { preimage: "proof" } });
        expect(session.readPaymentSession()).toBe(pointer);
        await records.updateSavedPayment(noteA, "missing", { promotionPaid: true });
        expect(records.restorePayment(noteA)?.promotionPaid).toBe(false);
    });
    it("retains archived records across reload and rejects a mismatched note record", async () => {
        let records = await import("./paymentRecords");
        await records.savePayment(makePayment(noteA, "old")); await records.savePayment(makePayment(noteA, "new"));
        sessionStorage.setItem(records.paymentKey(noteB), JSON.stringify(makePayment(noteA, "wrong")));
        vi.resetModules(); records = await import("./paymentRecords");
        await (await import("../../lib/paymentSession")).initializePaymentSessions();
        expect(records.unfinishedPayments(noteA).map((payment) => payment.board.paymentHash).sort()).toEqual(["new", "old"]);
        expect(records.restorePayment(noteB)).toBeNull();
        expect(records.restorePayment(noteA)?.board.paymentHash).toBe("new");
    });
    it("keeps old invoices in memory when tab storage is blocked", async () => {
        fixture.fail = true;
        vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("Blocked"); }, setItem: () => { throw new Error("Blocked"); }, removeItem: () => { throw new Error("Blocked"); }, get length() { throw new Error("Blocked"); } });
        const records = await import("./paymentRecords");
        await records.savePayment({ ...makePayment(noteA, "old"), editing: true }); await records.savePayment(makePayment(noteA, "new"));
        expect(records.unfinishedPayments(noteA)).toHaveLength(2);
        expect(records.restorePayment(noteA)?.board.paymentHash).toBe("new");
    });
    it("conservatively merges settlement learned by another tab and keeps all signed identity fields", async () => {
        const records = await import("./paymentRecords");
        const session = await import("../../lib/paymentSession");
        const payment = makePayment(noteA, "same");
        await records.savePayment(payment);
        const external = fixture.records.get(session.paymentBackendKey)!;
        external.payments.set(records.paymentKey(noteA), JSON.stringify({ ...payment, recoveryBackend: session.paymentBackend, promotionPaid: true, added: 168 }));
        await records.savePayment({ ...payment, editing: true });
        expect(records.restorePayment(noteA)).toMatchObject({ promotionPaid: true, added: 168, editing: true });
        await records.updateSavedPayment(noteA, "same", { note: noteB, board: makePayment(noteB, "other").board, editing: false, promotionPaid: false });
        expect(records.restorePayment(noteA)).toMatchObject({ note: noteA, board: { paymentHash: "same" }, promotionPaid: true, editing: true });
    });
    it("rejects malformed and foreign-backend records without deleting their originals", async () => {
        const records = await import("./paymentRecords");
        const session = await import("../../lib/paymentSession");
        for (const value of ["{broken", JSON.stringify({ ...makePayment(noteA, "x"), recoveryBackend: { ...session.paymentBackend, relayPubkey: "other" } }),
            JSON.stringify({ ...makePayment(noteA, "x"), recoveryBackend: session.paymentBackend, tipStatus: "unexpected" })]) {
            await session.savePaymentSession(records.paymentKey(noteA), value);
            expect(records.restorePayment(noteA)).toBeNull();
            expect(records.unfinishedPayments()).toEqual([]);
            expect(session.readPaymentSession(records.paymentKey(noteA))).toBe(value);
        }
    });
    it("never serializes connection credentials or guest key fields", async () => {
        const records = await import("./paymentRecords");
        const session = await import("../../lib/paymentSession");
        const payment = { ...makePayment(noteA, "clean"), guestKey: "secret-guest-key", nwc: "nostr+walletconnect://secret", signer: { secret: "signer-secret" } };
        await records.savePayment(payment);
        const raw = session.readPaymentSession(records.paymentKey(noteA))!;
        expect(raw).not.toMatch(/secret-guest-key|walletconnect|signer-secret/);
    });
    it("drops malformed optional drafts while preserving invoice amounts and rejects unsupported allocation bounds", async () => {
        const records = await import("./paymentRecords");
        const session = await import("../../lib/paymentSession");
        const base = { ...makePayment(noteA, "original"), recoveryBackend: session.paymentBackend };
        for (const draft of [{ config: null }, { amount: 100, authorShare: 100, amountSelection: { mode: "amount", custom: false, rank: null } }, "broken"]) {
            await session.savePaymentSession(records.paymentKey(noteA), JSON.stringify({ ...base, draft }));
            expect(records.restorePayment(noteA)?.draft).toBeUndefined();
            expect(records.restorePayment(noteA)?.board.amountSats).toBe(168);
            expect(records.restorePayment(noteA)?.author?.amount_sats).toBe(42);
        }
        await session.savePaymentSession(records.paymentKey(noteA), JSON.stringify({ ...base, authorShare: 100 }));
        expect(records.restorePayment(noteA)).toBeNull();
    });
    it("keeps a stale autosave on its archived hash without selecting it", async () => {
        const records = await import("./paymentRecords");
        const session = await import("../../lib/paymentSession");
        const old = makePayment(noteA, "old");
        await records.savePayment(old); await records.savePayment(makePayment(noteA, "new")); await records.savePayment(makePayment(noteB, "other"));
        const pointer = session.readPaymentSession();
        await records.savePayment({ ...old, promotionPaid: true }, false);
        expect(records.restorePayment(noteA)?.board.paymentHash).toBe("new");
        expect(session.readPaymentSession()).toBe(pointer);
        expect(records.unfinishedPayments(noteA).find(payment => payment.board.paymentHash === "old")?.promotionPaid).toBe(true);
    });
    it("does not delete another page's newer hash or an unresolved payment", async () => {
        const records = await import("./paymentRecords");
        await records.savePayment(makePayment(noteA, "old")); await records.savePayment(makePayment(noteA, "new"));
        await records.removeSavedPayment(noteA, "old");
        expect(records.restorePayment(noteA)?.board.paymentHash).toBe("new");
        await records.updateSavedPayment(noteA, "new", { boardAttempt: { state: "uncertain", walletId: "wallet" } });
        await records.removeSavedPayment(noteA, "new");
        expect(records.restorePayment(noteA)?.boardAttempt?.state).toBe("uncertain");
    });
    it.each(["board", "author"] as const)("keeps invoices when another tab committed an unseen %s attempt", async part => {
        const records = await import("./paymentRecords");
        const ledger = await import("../../lib/walletAttempts");
        const session = await import("../../lib/paymentSession");
        await ledger.initializeWalletAttempts();
        const payment = makePayment(noteA, "42".repeat(32));
        payment.author!.payment_hash = "43".repeat(32);
        await records.savePayment(payment);
        const pointer = session.readPaymentSession();
        const hash = part === "board" ? payment.board.paymentHash : payment.author!.payment_hash;
        fixture.attempts.set(hash, { attempt: { state: "uncertain", walletId: "original" }, revision: 1 });
        expect(ledger.getWalletAttempt(hash)).toBeUndefined();
        expect(await records.removeSavedPayment(noteA, payment.board.paymentHash)).toBe(false);
        expect(records.restorePayment(noteA)?.board).toEqual(payment.board);
        expect(session.readPaymentSession()).toBe(pointer);
    });
    it.each(["storage", "attempt storage", "locks", "malformed"])("refuses destructive restart with unavailable authority: %s", async failure => {
        const records = await import("./paymentRecords");
        const ledger = await import("../../lib/walletAttempts");
        const session = await import("../../lib/paymentSession");
        await ledger.initializeWalletAttempts();
        const payment = makePayment(noteA, "42".repeat(32));
        await records.savePayment(payment);
        const pointer = session.readPaymentSession();
        if (failure === "storage") fixture.fail = true;
        if (failure === "attempt storage") fixture.failAttempts = true;
        if (failure === "locks") vi.stubGlobal("navigator", {});
        if (failure === "malformed") fixture.attempts.set(payment.board.paymentHash, { attempt: { state: "future" } });
        expect(await records.removeSavedPayment(noteA, payment.board.paymentHash)).toBe(false);
        expect(records.restorePayment(noteA)?.board).toEqual(payment.board);
        expect(session.readPaymentSession()).toBe(pointer);
        // Failed destructive work must never replay later without its locks.
        fixture.fail = false; fixture.failAttempts = false;
        await records.savePayment({ ...payment, editing: true }, false);
        expect(records.restorePayment(noteA)?.board).toEqual(payment.board);
    });
    it.each(["board", "author"] as const)("holds the %s lock through deletion and rejects a competing send", async part => {
        const records = await import("./paymentRecords");
        const ledger = await import("../../lib/walletAttempts");
        const payments = await import("../../lib/walletPayment");
        await ledger.initializeWalletAttempts();
        const payment = makePayment(noteA, "42".repeat(32)); payment.author!.payment_hash = "43".repeat(32);
        await records.savePayment(payment);
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const paused = new Promise<void>(resolve => { entered = resolve; });
        fixture.beforeDelete = async () => { entered(); await gate; };
        const removal = records.removeSavedPayment(noteA, payment.board.paymentHash);
        await paused;
        expect(records.restorePayment(noteA)?.board).toEqual(payment.board);
        const payer = { id: "wallet", kind: "nwc" as const, enable: async () => {}, sendPayment: vi.fn() };
        const hash = part === "board" ? payment.board.paymentHash : payment.author!.payment_hash;
        await expect(payments.payInvoiceSafely(payer, "invoice", hash, undefined, vi.fn())).rejects.toThrow("in progress");
        expect(payer.sendPayment).not.toHaveBeenCalled();
        release(); expect(await removal).toBe(true);
        expect(records.restorePayment(noteA)).toBeNull();
    });
    it("a protective fact arriving during deletion is checked in the same transaction", async () => {
        const records = await import("./paymentRecords");
        const ledger = await import("../../lib/walletAttempts");
        await ledger.initializeWalletAttempts();
        const payment = makePayment(noteA, "42".repeat(32));
        await records.savePayment(payment);
        fixture.beforeDelete = async () => {
            await expect(ledger.saveWalletAttempt(payment.board.paymentHash, { state: "uncertain", walletId: "original" })).rejects.toThrow("in progress");
        };
        expect(await records.removeSavedPayment(noteA, payment.board.paymentHash)).toBe(false);
        expect(records.restorePayment(noteA)?.board).toEqual(payment.board);
        expect(fixture.attempts.get(payment.board.paymentHash)).toMatchObject({ attempt: { state: "uncertain" } });
    });
    it("refuses deletion if another tab replaced an unlocked recipient hash", async () => {
        const records = await import("./paymentRecords");
        const session = await import("../../lib/paymentSession");
        const payment = makePayment(noteA, "42".repeat(32));
        await records.savePayment(payment);
        fixture.beforeDelete = async () => {
            const snapshot = fixture.records.get(session.paymentBackendKey)!;
            const current = JSON.parse(snapshot.payments.get(records.paymentKey(noteA))!);
            current.author.payment_hash = "new-author";
            snapshot.payments.set(records.paymentKey(noteA), JSON.stringify(current));
        };
        expect(await records.removeSavedPayment(noteA, payment.board.paymentHash)).toBe(false);
        expect(records.restorePayment(noteA)?.author?.payment_hash).toBe("new-author");
    });
    it("keeps a replacement author invoice when old snapshots and responses arrive", async () => {
        const records = await import("./paymentRecords");
        const session = await import("../../lib/paymentSession");
        const original = makePayment(noteA, "board"); original.author!.expires_at = 1;
        const author = { ...original.author!, invoice: "lnbc-author-replacement", payment_hash: "author-replacement", expires_at: 2100000000 };
        await records.savePayment(original);
        const replaced = await records.replaceSavedAuthorInvoice(noteA, "board", original.author!.payment_hash, author, false);
        expect(replaced?.author).toEqual(author);
        const pointer = session.readPaymentSession();
        await records.savePayment({ ...original, promotionPaid: true, added: 168 }, false);
        expect(records.restorePayment(noteA)?.author).toEqual(author);
        await records.updateSavedPayment(noteA, "board", { tipStatus: "confirmed", authorAttempt: { state: "submitted", walletId: "wallet", preimage: "old-author-proof" } }, original.author!.payment_hash);
        expect(records.restorePayment(noteA)).toMatchObject({ author, tipStatus: "pending", promotionPaid: true });
        expect(records.restorePayment(noteA)?.authorAttempt).toBeUndefined();
        expect(JSON.parse(session.readPaymentSession()!).board.paymentHash).toBe(JSON.parse(pointer!).board.paymentHash);
    });
    it("accepts author state only for its expected hash, including explicit attempt resolution", async () => {
        const records = await import("./paymentRecords");
        const original = makePayment(noteA, "board"); original.author!.expires_at = 1;
        await records.savePayment(original);
        await records.updateSavedPayment(noteA, "board", { tipStatus: "confirmed", authorAttempt: { state: "submitted", walletId: "wallet" } });
        expect(records.restorePayment(noteA)?.tipStatus).toBe("pending");
        expect(records.restorePayment(noteA)?.authorAttempt).toBeUndefined();
        await records.updateSavedPayment(noteA, "board", { authorAttempt: { state: "uncertain", walletId: "wallet" } }, original.author!.payment_hash);
        const author = { ...original.author!, invoice: "lnbc-replacement", payment_hash: "replacement" };
        expect(await records.replaceSavedAuthorInvoice(noteA, "board", original.author!.payment_hash, author, false)).toBeNull();
        await records.updateSavedPayment(noteA, "board", { authorAttempt: { state: "unpaid", walletId: "wallet" } }, original.author!.payment_hash);
        expect((await records.replaceSavedAuthorInvoice(noteA, "board", original.author!.payment_hash, author, false))?.author).toEqual(author);
        expect(await records.replaceSavedAuthorInvoice(noteA, "board", original.author!.payment_hash, original.author!, false)).toBeNull();
    });
    it("replaces visibility using the latest other-recipient state and archives completed sessions", async () => {
        const records = await import("./paymentRecords");
        const session = await import("../../lib/paymentSession");
        const original = makePayment(noteA, "board"); original.board.expiresAt = 1;
        await records.savePayment(original);
        await records.updateSavedPayment(noteA, "board", { tipStatus: "confirmed", authorAttempt: { state: "submitted", walletId: "wallet", preimage: "author-proof" } }, original.author!.payment_hash);
        const board = { ...original.board, invoice: "lnbc-board-replacement", paymentHash: "replacement", expiresAt: 2100000000 };
        const replaced = await records.replaceSavedBoardInvoice(noteA, "board", board, false);
        expect(replaced).toMatchObject({ board, author: original.author, tipStatus: "confirmed", authorAttempt: { preimage: "author-proof" } });
        await records.updateSavedPayment(noteA, "replacement", { promotionPaid: true, added: 168 });
        await records.removeSavedPayment(noteA, "replacement");
        expect(session.readPaymentSession(records.paymentKey(noteA))).toBeNull();
        expect(JSON.parse(session.readPaymentSession(`${records.paymentKey(noteA)}:replacement`)!)).toMatchObject({ board, promotionPaid: true, tipStatus: "confirmed" });
    });
});
