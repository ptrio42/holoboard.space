import { fetchCampaigns, type CampaignPage } from "./campaigns";
import { nostrCache } from "./nostrCache";
import { verifiedNostrEvent } from "./verifyNostrEvent";

export interface ProfilePromotion { id: string; rank: number; satsPaid: number; weight: number }
export interface ProfilePromotionsSnapshot {
    entries: ProfilePromotion[]; pages: number; scanned: number; loading: boolean;
    hasMore: boolean; limited: boolean; error: boolean;
}
/** Scan existing active campaign pages, never infer promotion from public tags. */
export class ProfilePromotions {
    private value: ProfilePromotionsSnapshot = { entries: [], pages: 0, scanned: 0, loading: false, hasMore: true, limited: false, error: false };
    private next = 0;
    private closed = false;
    private controller?: AbortController;
    private running?: Promise<void>;
    private pubkey: string;
    private onUpdate: () => void;
    private fetchPage: typeof fetchCampaigns;
    constructor(pubkey: string, onUpdate: () => void = () => {}, fetchPage = fetchCampaigns) {
        this.pubkey = pubkey; this.onUpdate = onUpdate; this.fetchPage = fetchPage;
    }
    snapshot(): ProfilePromotionsSnapshot { return { ...this.value, entries: this.value.entries.map(entry => ({ ...entry })) }; }
    loadMore(): Promise<void> {
        if (this.closed || !this.value.hasMore || this.value.limited) return Promise.resolve();
        if (this.running) return this.running;
        const request = new AbortController(); this.controller = request;
        this.value.loading = true; this.value.error = false;
        const timer = setTimeout(() => request.abort("timeout"), 8000);
        this.running = this.fetchPage(this.next === 0 ? "board" : "top", this.next || 1, request.signal)
            .then(page => { if (!request.signal.aborted && !this.closed) this.admit(page); })
            .catch(() => { if (!this.closed) this.value.error = true; })
            .finally(() => {
                clearTimeout(timer); this.running = undefined;
                if (!this.closed) { if (request.signal.aborted) this.value.error = true; this.value.loading = false; this.onUpdate(); }
            });
        this.onUpdate(); return this.running;
    }
    private admit(page: CampaignPage) {
        // The existing API serves 21 entries. Reject oversized page expansion
        // while preserving the bounded prefix and making the limit explicit.
        if (page.entries.length > 21) this.value.limited = true;
        const knownCount = Number.isSafeInteger(page.activePosts) && page.activePosts >= 0;
        if (!knownCount) this.value.limited = true;
        const entries = new Map(this.value.entries.map(entry => [entry.id, entry]));
        for (const entry of page.entries.slice(0, 21)) {
            this.value.scanned++;
            if (entry.event.pubkey !== this.pubkey) continue;
            if (JSON.stringify(entry.event).length * 3 > 65536) { this.value.limited = true; continue; }
            const event = verifiedNostrEvent(entry.event);
            if (!event || event.id !== entry.id || ![1, 1111].includes(event.kind) || !Number.isSafeInteger(entry.rank) || entry.rank < 1 ||
                !Number.isFinite(entry.weight) || entry.weight <= 0 || !Number.isFinite(entry.satsPaid) || entry.satsPaid < 0) { this.value.limited = true; continue; }
            if (!entries.has(event.id) && entries.size >= 128) { this.value.limited = true; break; }
            nostrCache.put(event);
            entries.set(event.id, { id: event.id, rank: entry.rank, satsPaid: entry.satsPaid, weight: entry.weight });
        }
        this.value.entries = [...entries.values()].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
        this.value.pages++; this.next++;
        this.value.hasMore = !knownCount || (this.next === 1 ? page.activePosts > 21 : page.hasMore);
        if (this.value.pages >= 8 && this.value.hasMore) this.value.limited = true;
    }
    close() { this.closed = true; this.controller?.abort("cancelled"); }
}
