import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentRecoverySnapshot } from "./paymentRecoveryStore";

const fixture = vi.hoisted(() => ({ records: new Map<string, PaymentRecoverySnapshot>(), fail: false, pause: undefined as Promise<void> | undefined }));
vi.mock("./paymentRecoveryStore", () => ({ IndexedPaymentRecoveryStore: class {
    async change(backend: string, update: (snapshot: PaymentRecoverySnapshot) => void) {
        if (fixture.pause) await fixture.pause;
        if (fixture.fail) throw new Error("Storage blocked or full");
        const previous = fixture.records.get(backend);
        const next = { payments: new Map(previous?.payments), lastPayment: previous?.lastPayment ?? null };
        update(next); fixture.records.set(backend, next);
        return { payments: new Map(next.payments), lastPayment: next.lastPayment };
    }
} }));
beforeEach(() => {
    vi.resetModules(); fixture.records.clear(); fixture.fail = false; fixture.pause = undefined;
    const records = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
        get length() { return records.size; }, key: (index: number) => [...records.keys()][index] ?? null,
        getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value),
        removeItem: (key: string) => records.delete(key),
    });
});
afterEach(() => vi.unstubAllGlobals());

describe("private payment session cache", () => {
    it("exposes readiness only after initialization and durability only after commit", async () => {
        const session = await import("./paymentSession");
        let release!: () => void;
        fixture.pause = new Promise(resolve => { release = resolve; });
        const initializing = session.initializePaymentSessions();
        expect(session.getPaymentSessionStatus()).toMatchObject({ ready: false, persistent: false });
        release(); await initializing;
        expect(session.getPaymentSessionStatus()).toMatchObject({ ready: true, persistent: true });
        fixture.pause = new Promise(resolve => { release = resolve; });
        const saving = session.savePaymentSession("invoice", "original invoice");
        await vi.waitFor(() => expect(session.paymentSessionIsPersistent()).toBe(false));
        expect(session.readPaymentSession("invoice")).toBe("original invoice");
        expect(session.getPaymentSessionStatus()).toMatchObject({ persistent: false, saving: true, failed: false });
        release(); expect(await saving).toBe(true);
    });
    it("retains failed writes and deletions in memory and retries them without hiding archive failures", async () => {
        const session = await import("./paymentSession");
        await session.initializePaymentSessions();
        fixture.fail = true;
        expect(await session.savePaymentSession("archive", "old invoice", false)).toBe(false);
        expect(await session.savePaymentSession("current", "new invoice")).toBe(false);
        expect(session.readPaymentSession("archive")).toBe("old invoice");
        await session.removePaymentSession("archive");
        expect(session.readPaymentSession("archive")).toBeNull();
        fixture.fail = false;
        expect(await session.savePaymentSession("other", "another invoice")).toBe(true);
        vi.resetModules();
        const restored = await import("./paymentSession"); await restored.initializePaymentSessions();
        expect(restored.readPaymentSession("archive")).toBeNull();
        expect(restored.readPaymentSession("current")).toBe("new invoice");
    });
    it("recovers durable records in a fresh page without sessionStorage", async () => {
        let session = await import("./paymentSession");
        await session.savePaymentSession("first", "invoice A"); await session.savePaymentSession("second", "invoice B");
        await session.removePaymentSession("first");
        vi.stubGlobal("sessionStorage", { get length() { throw new Error("Blocked"); } });
        vi.resetModules(); session = await import("./paymentSession"); await session.initializePaymentSessions();
        expect(session.readPaymentSession()).toBe("invoice B");
        expect(session.readPaymentSession("first")).toBeNull();
        expect(session.paymentSessionIsPersistent()).toBe(true);
    });
    it("does not import legacy invoices whose backend cannot be established", async () => {
        const session = await import("./paymentSession");
        const key = `holoboard-payment:${"a".repeat(64)}`;
        // This is the actual old browser format. Note and invoice hashes say
        // nothing about which configured HTTP backend issued the invoice.
        const legacy = JSON.stringify({ note: "a".repeat(64), board: { paymentHash: "b".repeat(64), invoice: "lnbc-original" } });
        sessionStorage.setItem(key, legacy); sessionStorage.setItem("holoboard-last-payment", key);
        await session.initializePaymentSessions();
        expect(session.readPaymentSession(key)).toBeNull();
        expect(session.getPaymentSessionStatus().unverifiedLegacy).toBe(true);
        expect(sessionStorage.getItem(key)).toBe(legacy);
        expect(sessionStorage.getItem("holoboard-last-payment")).toBe(key);
    });
    it("imports only exact backend provenance and preserves compatibility originals", async () => {
        const session = await import("./paymentSession");
        const key = "holoboard-payment:original", other = "holoboard-payment:other";
        const value = JSON.stringify({ recoveryBackend: session.paymentBackend, board: { invoice: "original" } });
        sessionStorage.setItem(key, value);
        sessionStorage.setItem(other, JSON.stringify({ recoveryBackend: { ...session.paymentBackend, api: "https://other.example" } }));
        await session.initializePaymentSessions();
        expect(session.readPaymentSession(key)).toBe(value);
        expect(session.readPaymentSession(other)).toBeNull();
        expect(sessionStorage.getItem(key)).toBe(value);
    });
    it("strips credentials from compatible imports without altering their originals", async () => {
        const session = await import("./paymentSession");
        const key = "holoboard-payment:original";
        const value = JSON.stringify({ recoveryBackend: session.paymentBackend, board: { invoice: "invoice" }, guestKey: "secret-key", connection: "wallet-secret" });
        sessionStorage.setItem(key, value);
        await session.initializePaymentSessions();
        expect(session.readPaymentSession(key)).not.toMatch(/secret-key|wallet-secret/);
        expect(sessionStorage.getItem(key)).toBe(value);
    });
    it("keeps backend and relay identity scopes separate", async () => {
        const session = await import("./paymentSession");
        const foreignApi = JSON.stringify({ ...session.paymentBackend, api: "https://other.example" });
        const foreignIdentity = JSON.stringify({ ...session.paymentBackend, relayPubkey: "f".repeat(64) });
        for (const backend of [foreignApi, foreignIdentity]) fixture.records.set(backend, { payments: new Map([["secret-invoice", "other"]]), lastPayment: "secret-invoice" });
        await session.initializePaymentSessions();
        expect(session.listPaymentSessions("")).toEqual([]);
        await session.savePaymentSession("invoice", "ours");
        for (const backend of [foreignApi, foreignIdentity]) expect(fixture.records.get(backend)?.payments.get("secret-invoice")).toBe("other");
    });
});
