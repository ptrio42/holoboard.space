import type { Event } from "nostr-tools";
import { PUBLIC_RELAYS, RELAY_URL } from "../config";
import { nostrCache, newerEvent } from "./nostrCache";
import { profileMetadata, type SafeProfile } from "./profileMetadata";
import { DISCOVERY_RELAYS, relayCandidates } from "./relayPolicy";
import { withReadBudget } from "./readBudget";
import { queryNostr, type RelayOutcome } from "./nostrTransport";
import { verifiedNostrEvent } from "./verifyNostrEvent";

export interface ProfileSnapshot {
    pubkey: string; profile?: SafeProfile; event?: { id: string; created_at: number };
    state: "idle" | "loading" | "settled" | "partial";
    cached: boolean; malformed: boolean; limited: boolean;
    checkedAt?: number; relays: Record<string, RelayOutcome>; routing: Record<string, RelayOutcome>; cachedRouting: boolean;
}
interface Session {
    value: ProfileSnapshot; hints: string[]; views: Set<() => void>;
    controller?: AbortController; running?: Promise<void>;
}
export interface ProfileHandle { snapshot(): ProfileSnapshot; refresh(): Promise<void>; close(): void }

/** Shared metadata reads, including bylines. Bodies stay in the independent read cache. */
export class ProfileReader {
    private sessions = new Map<string, Session>();
    private handles = 0;
    open(pubkey: string, hints: string[] = [], onUpdate: () => void = () => {}): ProfileHandle {
        if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new TypeError("Invalid profile key");
        if (this.handles >= 256) throw new Error("Profile handle budget exhausted");
        let session = this.sessions.get(pubkey);
        if (!session) {
            if (this.sessions.size >= 64) throw new Error("Profile read budget exhausted");
            session = { hints: [], views: new Set(), value: { pubkey, state: "idle", cached: false, malformed: false, limited: false, relays: {}, routing: {}, cachedRouting: false } };
            this.sessions.set(pubkey, session);
            this.accept(session, nostrCache.query({ kinds: [0], authors: [pubkey], limit: 1 })[0], true);
        }
        session.hints = relayCandidates([...session.hints, ...hints], 4);
        // Every handle has a distinct callback even if callers pass the same function.
        const notify = () => onUpdate();
        session.views.add(notify); this.handles++;
        const current = session;
        let closed = false;
        return {
            snapshot: () => ({ ...current.value, profile: current.value.profile && { ...current.value.profile }, relays: { ...current.value.relays }, routing: { ...current.value.routing } }),
            refresh: () => closed ? Promise.resolve() : this.load(current),
            close: () => {
                if (closed) return;
                closed = true; current.views.delete(notify); this.handles--;
                if (current.views.size) return;
                current.controller?.abort("cancelled");
                if (!current.running) this.sessions.delete(pubkey);
            },
        };
    }
    private notify(session: Session) { for (const notify of session.views) notify(); }
    private accept(session: Session, input?: Event, cached = false) {
        if (!input) return;
        if (JSON.stringify(input).length * 3 > 65536) { session.value.limited = true; return; }
        const event = verifiedNostrEvent(input);
        if (!event || event.kind !== 0 || event.pubkey !== session.value.pubkey) return;
        const old = session.value.event;
        if (old && !newerEvent(event, old)) {
            if (!cached && old.id === event.id) { nostrCache.put(event); session.value.cached = false; }
            return;
        }
        if (!cached) nostrCache.put(event);
        const profile = profileMetadata(event);
        session.value = { ...session.value, event: { id: event.id, created_at: event.created_at }, profile, cached, malformed: !profile };
        this.notify(session);
    }
    private load(session: Session): Promise<void> {
        if (session.running) {
            // A view returning during cancellation joins the old shutdown first.
            return session.controller?.signal.aborted ? session.running.then(() => session.views.size ? this.load(session) : undefined) : session.running;
        }
        const controller = new AbortController(); session.controller = controller;
        session.value = { ...session.value, state: "loading", relays: {}, routing: {}, cachedRouting: false, limited: false };
        const timer = setTimeout(() => controller.abort("timeout"), 12000);
        session.running = this.run(session, controller).catch(() => {
            if (session.views.size) session.value = { ...session.value, state: "partial", limited: true };
        }).finally(() => {
            clearTimeout(timer); if (controller.signal.aborted && session.views.size) session.value.state = "partial"; session.controller = undefined; session.running = undefined;
            if (!session.views.size) this.sessions.delete(session.value.pubkey);
            else this.notify(session);
        });
        this.notify(session);
        return session.running;
    }
    private async run(session: Session, controller: AbortController) {
        await new Promise<void>((resolve, reject) => {
            const abort = () => reject(controller.signal.reason);
            if (controller.signal.aborted) { reject(controller.signal.reason); return; }
            controller.signal.addEventListener("abort", abort, { once: true });
            nostrCache.ready.then(() => { controller.signal.removeEventListener("abort", abort); resolve(); }, reject);
        });
        if (controller.signal.aborted) return;
        this.accept(session, nostrCache.query({ kinds: [0], authors: [session.value.pubkey], limit: 1 })[0], true);
        await withReadBudget(controller.signal, async () => {
            const pubkey = session.value.pubkey;
            const initial = relayCandidates([RELAY_URL, ...session.hints, ...PUBLIC_RELAYS], 8);
            const options = { signal: controller.signal, timeout: 6000, priority: 1,
                onEvent: (event: Event) => { if (!controller.signal.aborted) this.accept(session, event); } };
            const base = queryNostr({ kinds: [0], authors: [pubkey], limit: 1 }, initial, options);
            const cachedList = nostrCache.query({ kinds: [10002], authors: [pubkey], limit: 1 })[0];
            const discovery = cachedList ? undefined : queryNostr({ kinds: [10002], authors: [pubkey], limit: 1 }, relayCandidates([...DISCOVERY_RELAYS, ...session.hints, ...PUBLIC_RELAYS], 8), { signal: controller.signal, timeout: 4000, priority: 1 });
            const routing = await discovery;
            if (controller.signal.aborted) { await base; return; }
            const list = cachedList ?? routing?.events.reduce<Event | undefined>((old, event) => newerEvent(event, old) ? event : old, undefined);
            if (list) nostrCache.put(list);
            session.value.cachedRouting = !!cachedList;
            session.value.routing = routing?.relays ?? {};
            const writes = relayCandidates(list?.tags.filter(tag => tag[0] === "r" && (!tag[2] || tag[2] === "write")).map(tag => tag[1]) ?? [], 4);
            const additional = writes.filter(relay => !initial.includes(relay));
            const outbox = additional.length ? queryNostr({ kinds: [0], authors: [pubkey], limit: 1 }, additional, { ...options, priority: 2 }) : undefined;
            const [direct, authored] = await Promise.all([base, outbox]);
            if (controller.signal.aborted) return;
            // onEvent streams the usual transport; admitting the results also
            // keeps cache-only and test transports under the same trust boundary.
            for (const event of [...direct.events, ...authored?.events ?? []]) this.accept(session, event);
            session.value = { ...session.value, checkedAt: Date.now(), relays: { ...direct.relays, ...authored?.relays },
                state: direct.complete && (!authored || authored.complete) && (cachedList || routing?.complete) && !session.value.limited ? "settled" : "partial" };
        });
        if (controller.signal.aborted && session.views.size) session.value.state = "partial";
    }
    stats() { return { sessions: this.sessions.size, handles: this.handles }; }
}

export const profileReader = new ProfileReader();
/** Public metadata hints from verified NIP-65 write entries, never DM lists. */
export function profileRelayHints(pubkey: string): string[] {
    const list = nostrCache.query({ kinds: [10002], authors: [pubkey], limit: 1 })[0];
    return relayCandidates(list?.tags.filter(tag => tag[0] === "r" && (!tag[2] || tag[2] === "write")).map(tag => tag[1]) ?? [], 4);
}
const pending = new Map<string, Promise<SafeProfile | undefined>>();
/** Reuse verified metadata before the first paint of a newly mounted note. */
function cachedProfileEvent(pubkey: string): Event | undefined {
    const cached = nostrCache.query({ kinds: [0], authors: [pubkey], limit: 1 })[0];
    return cached && JSON.stringify(cached).length * 3 <= 65536 ? cached : undefined;
}
export function cachedProfileValue(pubkey: string): SafeProfile | undefined {
    const cached = cachedProfileEvent(pubkey);
    return cached ? profileMetadata(cached) : undefined;
}
export async function readProfileValue(pubkey: string, hints: string[] = []): Promise<SafeProfile | undefined> {
    if (!/^[0-9a-f]{64}$/.test(pubkey)) return;
    await nostrCache.ready;
    const cached = cachedProfileEvent(pubkey);
    if (cached) return profileMetadata(cached);
    if (pending.has(pubkey)) return pending.get(pubkey);
    if (pending.size >= 64) return;
    const handle = profileReader.open(pubkey, hints);
    const result = handle.refresh().then(() => handle.snapshot().profile).finally(() => { handle.close(); pending.delete(pubkey); });
    pending.set(pubkey, result);
    return result;
}
