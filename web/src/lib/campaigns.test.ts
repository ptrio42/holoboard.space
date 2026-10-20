import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCampaigns } from "./campaigns";

afterEach(() => vi.unstubAllGlobals());
const id = "a".repeat(64);
const discovery = { entry_type: "discovery", id, event: { id, kind: 1, content: "A useful discovery" }, first_visible_at: 1800000000,
    discovery: { reason: "A detailed account of restoring a community garden.", topic: "community", language: "en", expires_at: 1800604800, reward_sats: 100, reward_status: "pending" } };
const paid = { id: "paid", event: { id: "paid" }, rank: 22, weight: 10, sats_paid: 21, first_paid_at: 1700000000, hot_sats: 21, author_share: 20 };
function response(entries: unknown[], extra = {}) {
    return new Response(JSON.stringify({ entries, targets: [], active_posts: 22, total: entries.length, has_more: false, ...extra }));
}
describe("mixed discovery campaigns", () => {
    it("keeps ordinary campaign queries paid-only and accepts the legacy response", async () => {
        const fetch = vi.fn().mockResolvedValue(response([paid]));
        vi.stubGlobal("fetch", fetch);
        const page = await fetchCampaigns("new");
        expect(page.entries[0]).toMatchObject({ rank: 22, satsPaid: 21 });
        expect(fetch.mock.calls[0][0]).not.toContain("include_discoveries");
        expect(page.waitingPosts).toBeUndefined();
    });
    it("admits unranked discoveries only in opted-in New, without invented promotion values", async () => {
        const fetch = vi.fn().mockResolvedValue(response([discovery, paid], { waiting_posts: 2 }));
        vi.stubGlobal("fetch", fetch);
        const page = await fetchCampaigns("new", 1, undefined, true);
        expect(fetch.mock.calls[0][0]).toContain("include_discoveries=true");
        expect(page.waitingPosts).toBe(2);
        const first = page.entries[0];
        expect(first).toMatchObject({ entryType: "discovery", firstVisibleAt: 1800000000, discovery: { rewardStatus: "pending", rewardSats: 100 } });
        expect(first.rank).toBeUndefined();
        expect(first.satsPaid).toBeUndefined();
        expect(first.weight).toBeUndefined();
    });
    it("retains discovery history when a note acquires a paid rank", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([{ ...paid, entry_type: "promotion", first_visible_at: 1600000000, discovery: discovery.discovery }])));
        expect((await fetchCampaigns("new", 1, undefined, true)).entries[0]).toMatchObject({
            entryType: "promotion", rank: 22, firstVisibleAt: 1600000000, firstPaidAt: 1700000000, discovery: { rewardStatus: "pending" },
        });
    });
    it.each(["board", "top", "hot"] as const)("rejects an unranked discovery in %s", async view => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([discovery])));
        await expect(fetchCampaigns(view, 1, undefined, true)).rejects.toThrow("discovery entry");
    });
    it.each([
        { ...discovery, rank: 0 }, { ...discovery, sats_paid: 100 },
        { ...discovery, event: { id: "b".repeat(64) } },
        { ...discovery, discovery: { ...discovery.discovery, reward_status: "guaranteed" } },
        { ...discovery, discovery: { ...discovery.discovery, reward_sats: 10000 } },
    ])("rejects malformed or misleading discovery data", async entry => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([entry])));
        await expect(fetchCampaigns("new", 1, undefined, true)).rejects.toThrow();
    });
});
