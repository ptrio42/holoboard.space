import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedPaymentRecoveryStore, PAYMENT_RECOVERY_STORES } from "./paymentRecoveryStore";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function controlledDatabase() {
    const records = { result: [{ backend: "backend", key: "invoice", value: "original" }], onsuccess: undefined as (() => void) | undefined };
    const pointer = { result: { lastPayment: "invoice" }, onsuccess: undefined as (() => void) | undefined };
    const invoices = { index: vi.fn(() => ({ getAll: vi.fn(() => records) })), put: vi.fn(), delete: vi.fn() };
    const metadata = { get: vi.fn(() => pointer), put: vi.fn() };
    const transaction = { objectStore: (name: string) => name === PAYMENT_RECOVERY_STORES.invoices ? invoices : metadata,
        oncomplete: undefined as (() => void) | undefined, onabort: undefined as (() => void) | undefined,
        abort: vi.fn(() => transaction.onabort?.()) };
    const database = { transaction: vi.fn(() => transaction), close: vi.fn() };
    const request = { result: database, onsuccess: undefined as (() => void) | undefined };
    vi.stubGlobal("indexedDB", { open: vi.fn(() => { queueMicrotask(() => request.onsuccess?.()); return request; }) });
    return { records, pointer, invoices, metadata, transaction, database,
        async read() {
            await vi.waitFor(() => expect(records.onsuccess).toBeTypeOf("function"));
            records.onsuccess?.(); pointer.onsuccess?.();
        } };
}

describe("native private payment transactions", () => {
    it("does not report success at request success and rejects a later transaction abort", async () => {
        const fixture = controlledDatabase();
        const store = new IndexedPaymentRecoveryStore();
        let done = false;
        const write = store.change("backend", snapshot => snapshot.payments.set("invoice", "updated")).finally(() => { done = true; });
        // Attach the rejection handler before triggering the native abort.
        const rejected = expect(write).rejects.toThrow("did not commit");
        await fixture.read();
        expect(fixture.invoices.put).toHaveBeenCalledWith({ backend: "backend", key: "invoice", value: "updated" });
        await Promise.resolve(); expect(done).toBe(false);
        fixture.transaction.onabort?.(); await rejected;
    });
    it("returns the exact snapshot only after transaction completion and touches private stores", async () => {
        const fixture = controlledDatabase();
        const write = new IndexedPaymentRecoveryStore().change("backend", snapshot => {
            snapshot.payments.set("archived", snapshot.payments.get("invoice")!);
            snapshot.payments.set("invoice", "new invoice"); snapshot.lastPayment = "invoice";
        });
        await fixture.read();
        fixture.transaction.oncomplete?.();
        const result = await write;
        expect([...result.payments]).toEqual([["invoice", "new invoice"], ["archived", "original"]]);
        expect(fixture.database.transaction).toHaveBeenCalledWith(["invoices", "metadata"], "readwrite");
        expect(fixture.metadata.put).toHaveBeenCalledWith({ backend: "backend", lastPayment: "invoice" });
    });
    it("aborts the entire update if the mutation throws", async () => {
        const fixture = controlledDatabase();
        const write = new IndexedPaymentRecoveryStore().change("backend", () => { throw new Error("Invalid record"); });
        const rejected = expect(write).rejects.toThrow("Invalid record");
        await fixture.read(); await rejected;
        expect(fixture.transaction.abort).toHaveBeenCalledOnce();
        expect(fixture.invoices.put).not.toHaveBeenCalled();
    });
    it("retries synchronous blocked-storage errors without leaking deadlines", async () => {
        vi.useFakeTimers();
        const open = vi.fn(() => { throw new DOMException("Blocked", "SecurityError"); });
        vi.stubGlobal("indexedDB", { open });
        const store = new IndexedPaymentRecoveryStore();
        for (let index = 0; index < 3; index++) await expect(store.read("backend")).rejects.toThrow("Blocked");
        expect(open).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
    });
    it("ends a transaction that never completes instead of claiming durable storage", async () => {
        const fixture = controlledDatabase();
        const write = new IndexedPaymentRecoveryStore().read("backend");
        const rejected = expect(write).rejects.toThrow("timed out");
        await fixture.read();
        await rejected;
        expect(fixture.transaction.abort).toHaveBeenCalledOnce();
    });
});
