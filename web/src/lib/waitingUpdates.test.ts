import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());
describe("local waiting-room visit checkpoints", () => {
    it("scopes storage to the backend and never moves a checkpoint backwards", async () => {
        const storage = new Map<string, string>();
        vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
        const visit = await import("./waitingUpdates");
        expect(visit.waitingVisitKey).toContain("/api/board");
        expect(visit.readWaitingVisit()).toBeNull();
        visit.saveWaitingVisit(2000); visit.saveWaitingVisit(1000);
        expect(visit.readWaitingVisit()).toBe(2000);
        storage.set(visit.waitingVisitKey, "3000");
        expect(visit.readWaitingVisit()).toBe(3000);
        visit.saveWaitingVisit(NaN); visit.saveWaitingVisit(-1);
        expect(visit.readWaitingVisit()).toBe(3000);
    });
    it("keeps visit memory when storage is blocked", async () => {
        vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
        const visit = await import("./waitingUpdates");
        expect(visit.readWaitingVisit()).toBeNull();
        visit.saveWaitingVisit(5000);
        expect(visit.readWaitingVisit()).toBe(5000);
    });
    it("rejects incomplete update data and accepts exact IDs beyond one page", async () => {
        const ids = Array.from({ length: 25 }, (_, index) => index.toString(16).padStart(64, "0"));
        const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ count: 25, note_ids: ids, checked_at: 6000 })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ count: 25, note_ids: [ids[0]], checked_at: 6000 })))
            .mockResolvedValueOnce(new Response("offline", { status: 503 }));
        vi.stubGlobal("fetch", fetch);
        const { fetchWaitingUpdates } = await import("./waitingUpdates");
        const signal = new AbortController().signal;
        expect(await fetchWaitingUpdates(5000, signal)).toEqual({ count: 25, noteIds: ids, checkedAt: 6000 });
        expect(fetch.mock.calls[0][0]).toContain("?since=5000");
        await expect(fetchWaitingUpdates(5000, signal)).rejects.toThrow("Incomplete");
        await expect(fetchWaitingUpdates(5000, signal)).rejects.toThrow("Could not check");
    });
});
