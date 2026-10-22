import { vi } from "vitest";

/** Mock only native persistence and Web Locks, keeping coordinator policy real. */
const recovery = vi.hoisted(() => ({
    records: new Map<string, unknown>(), fail: false, pause: undefined as Promise<void> | undefined,
}));
vi.mock("../../src/lib/paymentRecoveryStore", async (original) => {
    const actual = await original<typeof import("../../src/lib/paymentRecoveryStore")>();
    return { ...actual, IndexedPaymentRecoveryStore: class {
        async readWalletAttempts() { return new Map(recovery.records); }
        async changeWalletAttempt(hash: string, update: (record: unknown) => unknown) {
            if (recovery.pause) await recovery.pause;
            if (recovery.fail) throw new Error("Private payment storage did not commit.");
            const record = update(recovery.records.get(hash));
            recovery.records.set(hash, structuredClone(record));
            return structuredClone(record);
        }
    } };
});
export function setupWalletRecovery() {
    recovery.records.clear(); recovery.fail = false; recovery.pause = undefined;
    const tab = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { get length() { return tab.size; }, key: (index: number) => [...tab.keys()][index] ?? null, getItem: (key: string) => tab.get(key) ?? null, setItem: (key: string, value: string) => tab.set(key, value) });
    const active = new Set<string>();
    vi.stubGlobal("navigator", { locks: { request: async (name: string, _options: unknown, action: (lock: object | null) => Promise<unknown>) => {
        if (active.has(name)) return action(null);
        active.add(name);
        try { return await action({ name }); } finally { active.delete(name); }
    } } });
}

export { recovery };
