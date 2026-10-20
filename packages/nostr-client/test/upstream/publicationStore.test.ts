import { afterEach, expect, it, vi } from "vitest";
import { IndexedPublicationStore } from "../fixtures/legacyCore";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("retries synchronous blocked-storage failures without accumulating opening deadlines", async () => {
    vi.useFakeTimers();
    const open = vi.fn(() => { throw new DOMException("blocked", "SecurityError"); });
    vi.stubGlobal("indexedDB", { open });
    const store = new IndexedPublicationStore();
    for (let i = 0; i < 20; i++) await expect(store.read()).rejects.toThrow("blocked");
    expect(open).toHaveBeenCalledTimes(20);
    expect(vi.getTimerCount()).toBe(0);
});
