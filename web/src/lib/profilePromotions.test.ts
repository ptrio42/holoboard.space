import { expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { ProfilePromotions } from "./profilePromotions";
import type { CampaignEntry, CampaignPage } from "./campaigns";
const key = generateSecretKey();
const make = (content: string) => finalizeEvent({ kind: 1, created_at: 100, content, tags: [] }, key);
const event = make("Original promoted note");
const entry = (rank = 1, note = event): CampaignEntry => ({ id: note.id, event: note, rank, weight: 200, satsPaid: 210, firstPaidAt: 100, hotSats: 0, authorShare: 20 });
const page = (entries: CampaignEntry[] = [], hasMore = false): CampaignPage => ({ entries, hasMore, total: 42, activePosts: 42, targets: [] });
it("joins verified note authors with campaign membership, preserving board order and deduplication", async () => {
    const foreign = finalizeEvent({ kind: 1, created_at: 100, content: "Not this author", tags: [["p", event.pubkey]] }, generateSecretKey());
    const fetcher = vi.fn().mockResolvedValueOnce(page([entry(2), entry(1, foreign)]))
        .mockResolvedValueOnce(page([entry(2), entry(22, make("Waiting note")), { ...entry(23), id: "f".repeat(64) }]));
    const read = new ProfilePromotions(event.pubkey, undefined, fetcher);
    await read.loadMore(); await read.loadMore();
    expect(fetcher.mock.calls.map(([view, page]) => [view, page])).toEqual([["board", 1], ["top", 1]]);
    expect(read.snapshot()).toMatchObject({ pages: 2, scanned: 5, hasMore: false, limited: true });
    expect(read.snapshot().entries.map(item => item.rank)).toEqual([2, 22]); read.close();
});
it("retries the same failed page, keeps earlier notes and ignores late responses after closing", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(page([entry()])).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(page());
    const read = new ProfilePromotions(event.pubkey, undefined, fetcher);
    await read.loadMore(); await read.loadMore();
    expect(read.snapshot()).toMatchObject({ error: true, pages: 1, entries: [expect.objectContaining({ id: event.id })] });
    await read.loadMore(); expect(fetcher.mock.calls[2][1]).toBe(1);
    let deliver!: (value: CampaignPage) => void;
    const delayed = new ProfilePromotions(event.pubkey, undefined, vi.fn().mockImplementation(() => new Promise(resolve => { deliver = resolve; })));
    const job = delayed.loadMore(); delayed.close(); deliver(page([entry()])); await job;
    expect(delayed.snapshot().entries).toEqual([]); read.close();
});
it("stops a scan at its lifetime page bound and deduplicates concurrent load actions", async () => {
    const fetcher = vi.fn().mockResolvedValue(page([], true));
    const read = new ProfilePromotions(event.pubkey, undefined, fetcher);
    await Promise.all([read.loadMore(), read.loadMore()]);
    for (let i = 0; i < 20; i++) await read.loadMore();
    expect(fetcher).toHaveBeenCalledTimes(8); expect(read.snapshot()).toMatchObject({ limited: true, pages: 8, hasMore: true }); read.close();
});
it("keeps invalid campaign counts inconclusive instead of claiming an exhausted scan", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ...page([entry()]), activePosts: NaN });
    const read = new ProfilePromotions(event.pubkey, undefined, fetcher);
    await read.loadMore();
    expect(read.snapshot()).toMatchObject({ limited: true, hasMore: true, pages: 1 });
    expect(read.snapshot().entries).toHaveLength(1);
    await read.loadMore(); expect(fetcher).toHaveBeenCalledTimes(1); read.close();
});
