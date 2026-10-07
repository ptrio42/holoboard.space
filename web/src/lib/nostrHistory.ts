import type { Event, Filter } from "nostr-tools";
import { queryNostr, type QueryResult } from "./nostrTransport";

export interface HistoryCursor { until: number; boundaryIds: string[]; limit: number }
export interface HistoryPage extends QueryResult {
    next?: HistoryCursor;
    exhausted: boolean;
    truncated: boolean;
}

/** Inclusive timestamp pagination never skips a saturated timestamp silently. */
export function historyPageResult(result: QueryResult, limit: number, cursor?: HistoryCursor): HistoryPage {
    const previous = new Set(cursor?.boundaryIds ?? []);
    const events = result.events.filter((event) => event.created_at !== cursor?.until || !previous.has(event.id));
    const counts = new Map<string, number>();
    const oldestByRelay = new Map<string, number>();
    for (const event of result.events) for (const source of result.sources[event.id] ?? []) {
        counts.set(source, (counts.get(source) ?? 0) + 1);
        oldestByRelay.set(source, Math.min(oldestByRelay.get(source) ?? Infinity, event.created_at));
    }
    const full = [...counts.values()].some((count) => count >= limit);
    const exhausted = result.complete && !full;
    // A common cursor must not pass the earliest unseen range of any full
    // relay page. Taking the oldest event across all relays can skip history.
    const fullBoundaries = [...counts].filter(([, count]) => count >= limit).map(([source]) => oldestByRelay.get(source)!);
    const oldest = fullBoundaries.length ? Math.max(...fullBoundaries) : result.events.at(-1)?.created_at ?? cursor?.until;
    let next: HistoryCursor | undefined;
    let truncated = Object.values(result.relays).includes("budget");
    // Failed sources need a retry of the same request before advancing.
    if (result.complete && !exhausted && oldest !== undefined) {
        const stalled = cursor?.until === oldest && events.length === 0;
        if (stalled && limit >= 512) truncated = true;
        else {
            const boundaryIds = result.events.filter((event) => event.created_at === oldest).map((event) => event.id);
            next = { until: oldest, boundaryIds: cursor?.until === oldest ? [...new Set([...previous, ...boundaryIds])].slice(0, 512) : boundaryIds,
                limit: stalled ? Math.min(512, limit * 2) : limit };
        }
    }
    return { ...result, events, next, exhausted, truncated };
}

export async function readHistoryPage(filter: Filter, relays: string[], cursor?: HistoryCursor, signal?: AbortSignal): Promise<HistoryPage> {
    const limit = Math.max(1, Math.min(512, cursor?.limit ?? filter.limit ?? 100));
    const result = await queryNostr({ ...filter, until: cursor?.until ?? filter.until, limit }, relays, { signal });
    return historyPageResult(result, limit, cursor);
}

/** Merge pages by ID; callers retain a bounded cursor per discussion/profile. */
export function mergeHistory(current: Event[], page: Event[], max = 1024): Event[] {
    let bytes = 0;
    return [...new Map([...current, ...page].map((event) => [event.id, event])).values()]
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)).slice(0, max)
        .filter((event) => { bytes += JSON.stringify(event).length * 3; return bytes <= 8_388_608; });
}
