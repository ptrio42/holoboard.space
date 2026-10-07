import { withReadBudget } from "./readBudget";
import { type Event, type Filter } from "nostr-tools";
import { PUBLIC_RELAYS, RELAY_URL } from "../config";
import { DISCOVERY_RELAYS, relayCandidates } from "./relayPolicy";
import { nostrCache } from "./nostrCache";
import { queryNostr, type QueryResult } from "./nostrTransport";

const inflightLists = new Map<string, Promise<Event | undefined>>();
const listFailures = new Map<string, number>();
export async function relayList(author: string, hints: string[] = []): Promise<Event | undefined> {
    await nostrCache.ready;
    const cached = nostrCache.query({ kinds: [10002], authors: [author], limit: 1 })[0];
    if (cached) return cached;
    const lookupKey = `${author}:${relayCandidates(hints).join(",")}`;
    if ((listFailures.get(lookupKey) ?? 0) > Date.now()) return;
    let pending = inflightLists.get(lookupKey);
    if (pending) return pending;
    if (inflightLists.size >= 8) return;
    pending = queryNostr({ kinds: [10002], authors: [author], limit: 1 }, [...DISCOVERY_RELAYS, ...PUBLIC_RELAYS, ...relayCandidates(hints, 4)], { timeout: 4000, priority: 1 })
        .then((result) => {
            const event = result.events[0];
            if (event) nostrCache.put(event);
            else {
                listFailures.set(lookupKey, Date.now() + 30_000);
                if (listFailures.size > 256) listFailures.delete(listFailures.keys().next().value!);
            }
            return event;
        }).finally(() => inflightLists.delete(lookupKey));
    inflightLists.set(lookupKey, pending);
    return pending;
}
export async function authorRelays(author: string, hints: string[] = []): Promise<string[]> {
    const list = await relayList(author, hints);
    return relayCandidates(list?.tags.filter((tag) => tag[0] === "r" && (!tag[2] || tag[2] === "write")).map((tag) => tag[1]) ?? [], 4);
}

/** Cached data is useful immediately; network completeness remains separate. */
export async function readNostr(filter: Filter, hints: string[] = [], author?: string, options: {
    signal?: AbortSignal; onEvent?: (event: Event) => void; timeout?: number;
} = {}): Promise<QueryResult> {
    await nostrCache.ready;
    if (options.signal?.aborted) return { events: [], sources: {}, relays: {}, complete: false };
    const cached = nostrCache.query(filter);
    for (const event of cached) options.onEvent?.(event);
    if (filter.ids?.length === 1 && cached.length) return { events: cached, sources: {}, relays: {}, complete: false };
    return withReadBudget(options.signal, async () => {
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort("timeout"), options.timeout ?? 15_000);
        const abort = () => controller.abort(options.signal?.reason);
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
        const events = new Map(cached.map((event) => [event.id, event]));
        const onEvent = (event: Event) => {
            if (controller.signal.aborted) return;
            events.set(event.id, event); nostrCache.put(event); options.onEvent?.(event);
            if (filter.ids?.length === 1) controller.abort("found");
        };
        const initial = relayCandidates([RELAY_URL, ...PUBLIC_RELAYS, ...relayCandidates(hints, 4)]);
        const base = queryNostr(filter, initial, { ...options, signal: controller.signal, first: !!filter.ids?.length, onEvent });
        const discovered = author ? authorRelays(author, hints).then((writes) => {
            if (controller.signal.aborted) return undefined;
            const additional = writes.filter((url) => !initial.includes(url));
            return additional.length ? queryNostr(filter, additional, { ...options, signal: controller.signal, first: !!filter.ids?.length, priority: 2, onEvent }) : undefined;
        }) : Promise.resolve(undefined);
        try {
            const [direct, outbox] = await Promise.all([base, discovered]);
            const sorted = [...events.values()].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
            return { events: sorted.slice(0, filter.limit ?? 512), sources: { ...direct.sources, ...outbox?.sources },
                relays: { ...direct.relays, ...outbox?.relays }, complete: direct.complete && (!author || !!outbox?.complete) };
        } finally { clearTimeout(deadline); controller.abort(); options.signal?.removeEventListener("abort", abort); }
    });
}

export { profileMetadata, type SafeProfile } from "./profileMetadata";
export { readProfileValue as readProfile } from "./profileReads";
