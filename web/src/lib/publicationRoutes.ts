import type { Event } from "nostr-tools";
import { PUBLIC_RELAYS } from "../config";
import { nostrCache, newerEvent } from "./nostrCache";
import { DISCOVERY_RELAYS, relayCandidates } from "./relayPolicy";
import { queryNostr, type RelayOutcome } from "./nostrTransport";
import { withReadBudget } from "./readBudget";
import { verifiedNostrEvent } from "./verifyNostrEvent";
export interface PublicationRoutes {
    targets: string[]; partial: boolean; limited: boolean;
    sources: { pubkey: string; role: "author" | "recipient"; cached: boolean; relays: Record<string, RelayOutcome> }[];
}
/** Public notes only: author writes, tagged recipients' reads and configured
 * publication fallbacks. Discovery relays never become destinations by discovery alone.
 */
export async function publicationRoutes(input: Event, signal?: AbortSignal): Promise<PublicationRoutes> {
    if (JSON.stringify(input).length * 3 > 65536) throw new RangeError("Publication exceeds its event limit.");
    const event = verifiedNostrEvent(input);
    if (!event || ![1, 1111].includes(event.kind)) throw new TypeError("A verified public note or comment is required.");
    const references = event.tags.filter(tag => tag[0] === "e" || tag[0] === "E").map(tag => event.kind === 1 ? tag[4] : tag[3]);
    const mentioned = event.tags.filter(tag => tag[0] === "p" || tag[0] === "P").map(tag => tag[1]).sort();
    const recipients = [...new Set([...references, ...mentioned].filter((pubkey): pubkey is string => typeof pubkey === "string" && /^[0-9a-f]{64}$/.test(pubkey) && pubkey !== event.pubkey))];
    const roles = [{ pubkey: event.pubkey, role: "author" as const }, ...recipients.slice(0, 4).map(pubkey => ({ pubkey, role: "recipient" as const }))];
    const result: PublicationRoutes = { targets: [], partial: false, limited: recipients.length > 4, sources: [] };
    const groups: string[][] = Array.from({ length: roles.length }, () => []);
    groups.push(relayCandidates(PUBLIC_RELAYS, 12));
    const controller = new AbortController(); const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort("timeout"), 12000);
    try {
        await new Promise<void>((resolve, reject) => {
            const cancelled = () => reject(controller.signal.reason);
            controller.signal.addEventListener("abort", cancelled, { once: true });
            nostrCache.ready.then(() => { controller.signal.removeEventListener("abort", cancelled); resolve(); }, reject);
            if (controller.signal.aborted) cancelled();
        });
        const completed = await withReadBudget(controller.signal, () => Promise.allSettled(roles.map(async ({ pubkey, role }, index) => {
            const cached = nostrCache.query({ kinds: [10002], authors: [pubkey], limit: 1 })[0];
            const read = cached ? undefined : await queryNostr({ kinds: [10002], authors: [pubkey], limit: 1 }, relayCandidates([...DISCOVERY_RELAYS, ...PUBLIC_RELAYS], 8), { signal: controller.signal, timeout: 4000, priority: 1 });
            const list = cached ?? read?.events.reduce<Event | undefined>((old, candidate) => {
                const verified = verifiedNostrEvent(candidate);
                return verified?.kind === 10002 && verified.pubkey === pubkey && newerEvent(verified, old) ? verified : old;
            }, undefined);
            result.sources.push({ pubkey, role, cached: !!cached, relays: read?.relays ?? {} });
            if (!list || read && !read.complete) result.partial = true;
            if (list) {
                if (!cached) nostrCache.put(list);
                const relays = list.tags.filter(tag => tag[0] === "r" && (!tag[2] || tag[2] === (role === "author" ? "write" : "read"))).map(tag => tag[1]);
                groups[index] = relayCandidates(relays, 4);
                if (!groups[index].length) result.partial = true;
                if (relayCandidates(relays, 12).length > 4) result.limited = true;
            }
        })));
        if (completed.some(result => result.status === "rejected")) result.partial = true;
    } catch { result.partial = true; }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort(); }
    // Round-robin routing gives each selected recipient and configured fallback
    // a bounded opportunity when their combined advertised list exceeds 12.
    const targets = new Set<string>();
    for (let index = 0; index < 12; index++) for (const group of groups) if (group[index]) {
        if (targets.size < 12) targets.add(group[index]); else if (!targets.has(group[index])) result.limited = true;
    }
    result.targets = [...targets]; result.sources.sort((a, b) => roles.findIndex(role => role.pubkey === a.pubkey) - roles.findIndex(role => role.pubkey === b.pubkey));
    return result;
}
