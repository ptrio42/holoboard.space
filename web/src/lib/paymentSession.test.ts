import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("payment session persistence", () => {
    it("does not resurrect a removed session when storage refuses removal", async () => {
        const stored = new Map<string, string>();
        vi.stubGlobal("sessionStorage", {
            getItem: (key: string) => stored.get(key) ?? null,
            setItem: (key: string, value: string) => stored.set(key, value),
            removeItem: () => { throw new DOMException("Blocked", "SecurityError"); },
        });
        const session = await import("./paymentSession");
        session.savePaymentSession("other", "another note");
        session.savePaymentSession("payment", "old invoice");
        session.removePaymentSession("payment");
        expect(session.readPaymentSession()).toBeNull();
        expect(session.readPaymentSession("payment")).toBeNull();
        expect(session.readPaymentSession("other")).toBe("another note");
        session.savePaymentSession("payment", "new invoice");
        expect(session.readPaymentSession()).toBe("new invoice");
    });
    it("retains the latest attempt in memory when storage refuses writes", async () => {
        const stored = new Map<string, string>([["payment", "old"]]);
        vi.stubGlobal("sessionStorage", {
            getItem: (key: string) => stored.get(key) ?? null,
            setItem: () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); },
            removeItem: (key: string) => stored.delete(key),
        });
        const session = await import("./paymentSession");
        expect(session.readPaymentSession("payment")).toBe("old");
        expect(session.savePaymentSession("payment", "uncertain")).toBe(false);
        expect(session.readPaymentSession()).toBe("uncertain");
        expect(session.readPaymentSession("payment")).toBe("uncertain");
        expect(session.paymentSessionIsPersistent()).toBe(false);
        session.removePaymentSession("payment");
        expect(session.readPaymentSession()).toBeNull();
    });
    it("works while storage access is blocked and forgets memory on a reload", async () => {
        vi.stubGlobal("sessionStorage", {
            getItem: () => { throw new DOMException("Blocked", "SecurityError"); },
            setItem: () => { throw new DOMException("Blocked", "SecurityError"); },
            removeItem: () => { throw new DOMException("Blocked", "SecurityError"); },
        });
        const session = await import("./paymentSession");
        expect(session.readPaymentSession()).toBeNull();
        session.savePaymentSession("first", "confirmed visibility, uncertain author");
        session.savePaymentSession("second", "another note");
        expect(session.readPaymentSession("first")).toBe("confirmed visibility, uncertain author");
        session.removePaymentSession("second");
        expect(session.readPaymentSession("second")).toBeNull();
        expect(session.readPaymentSession("first")).not.toBeNull();
        vi.resetModules();
        expect((await import("./paymentSession")).readPaymentSession("first")).toBeNull();
    });
    it("restores persistent invoices after module reload and removes only the selected payment", async () => {
        const stored = new Map<string, string>();
        vi.stubGlobal("sessionStorage", {
            getItem: (key: string) => stored.get(key) ?? null,
            setItem: (key: string, value: string) => stored.set(key, value),
            removeItem: (key: string) => stored.delete(key),
        });
        const session = await import("./paymentSession");
        expect(session.savePaymentSession("first", "invoice A")).toBe(true);
        session.savePaymentSession("second", "invoice B");
        session.removePaymentSession("first");
        vi.resetModules();
        const restored = await import("./paymentSession");
        expect(restored.readPaymentSession()).toBe("invoice B");
        expect(restored.readPaymentSession("first")).toBeNull();
    });
});
