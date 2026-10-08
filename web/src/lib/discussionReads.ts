import { matchFilter, type Event, type Filter } from "nostr-tools";
import { PUBLIC_RELAYS, RELAY_URL } from "../config";
import { nostrCache, newerEvent, replaceableKey } from "./nostrCache";
import { historyPageResult, type HistoryCursor } from "./nostrHistory";
import { queryNostr, type QueryResult, type RelayOutcome } from "./nostrTransport";
import { withReadBudget } from "./readBudget";
import { DISCOVERY_RELAYS, relayCandidates } from "./relayPolicy";
import { createThreadGraph, reduceThreadGraph, type ThreadEvent, type ThreadGraph } from "./threadGraph";
import { normalizeThreadRelations, parseThreadAddress, relationKey, type RelationTarget } from "./threadRelations";
import { verifiedNostrEvent } from "./verifyNostrEvent";

export interface DiscussionLimits {
    maxSessions: number;
    maxHandles: number;
    maxTargets: number;
    maxLookups: number;
    maxBranches: number;
    maxRelays: number;
    maxAuthors: number;
    maxRequests: number;
    requestsPerRun: number;
    maxPages: number;
    pageSize: number;
    maxEvents: number;
    maxBytes: number;
    maxEventBytes: number;
    runTimeout: number;
    queryTimeout: number;
}
export const DISCUSSION_LIMITS: Readonly<DiscussionLimits> = Object.freeze({
    maxSessions: 4, maxHandles: 16, maxTargets: 64, maxLookups: 64,
    maxBranches: 256, maxRelays: 8, maxAuthors: 8, maxRequests: 128,
    requestsPerRun: 16, maxPages: 16, pageSize: 100, maxEvents: 1024,
    maxBytes: 4 * 1024 * 1024, maxEventBytes: 256 * 1024,
    runTimeout: 30_000, queryTimeout: 4000,
});

type Limitation = "targets" | "lookups" | "branches" | "relays" | "authors" | "requests" | "pages" | "events" | "bytes" | "event-size";
type StopReason = "batch" | "timeout" | "cancelled" | "error" | "events" | "bytes" | "requests";
export interface DiscussionCoverage {
    key: string;
    purpose: "ancestor" | "descendants";
    target: RelationTarget;
    relay: string;
    filter: Filter;
    outcome?: RelayOutcome;
    pages: number;
    cursor?: HistoryCursor;
    exhausted: boolean;
    truncated: boolean;
    /** An exact event was found, possibly in cache or on a different relay. */
    satisfied: boolean;
}
export interface DiscussionRouting {
    author: string;
    read: string[];
    write: string[];
    relays: Record<string, RelayOutcome>;
    fromCache: boolean;
}
export interface DiscussionSnapshot {
    focusId: string;
    /** Fixed upper timestamp for descendant pages in this shared session. */
    until: number;
    graph: ThreadGraph;
    state: "idle" | "loading" | "paused" | "settled" | "closed";
    coverage: DiscussionCoverage[];
    routing: DiscussionRouting[];
    /** Eligible checks derived from the graph, without reserved network records. */
    queuedWork: { ancestor: number; descendants: number };
    limitations: Limitation[];
    stopReason?: StopReason;
    /** Local retention loss is independent of per-relay network coverage. */
    retentionLimited: boolean;
    observedEvents: number;
    requests: number;
    receivedBytes: number;
    hasMore: boolean;
}
export interface DiscussionHandle {
    snapshot(): DiscussionSnapshot;
    /** Bounded batch; failed sources retry their own cursor on the next call. */
    loadMore(): Promise<DiscussionSnapshot>;
    close(): void;
}
interface Lookup { target: RelationTarget; filter: Filter }
type WorkClass = "critical" | "focus" | "ancestors" | "replies";
interface PlannedWork { work: DiscussionCoverage; group: WorkClass; rank: number[] }
const WORK_TURNS: readonly WorkClass[] = ["focus", "ancestors", "focus", "replies"];
function compareRank(a: number[], b: number[]) {
    for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] - b[index];
    return 0;
}
interface Route extends DiscussionRouting { attempted: boolean; hints: string[] }
interface Session {
    focusId: string;
    focusAuthor?: string;
    hints: string[];
    until: number;
    handles: Map<number, (() => void) | undefined>;
    observed: Set<string>;
    sources: Map<string, string[]>;
    targets: Set<string>;
    lookups: Map<string, Lookup>;
    work: Map<string, DiscussionCoverage>;
    routes: Map<string, Route>;
    cachedTargets: Set<string>;
    queuedWork: DiscussionSnapshot["queuedWork"];
    turn: number;
    limitations: Set<Limitation>;
    retentionLimited: boolean;
    requests: number;
    receivedBytes: number;
    state: DiscussionSnapshot["state"];
    stopReason?: StopReason;
    controller?: AbortController;
    running?: Promise<DiscussionSnapshot>;
}

const exactTarget = (id: string): RelationTarget => ({ type: "event", value: id, relays: [], hints: [] });
const exactId = (target: RelationTarget) => target.type === "event" ? target.value : target.exactId;
const lookupKey = (target: RelationTarget) => exactId(target) ? `event:${exactId(target)}` : relationKey(target);
function lookupFilter(target: RelationTarget): Filter | undefined {
    const id = exactId(target);
    // Fetch the signed event even if its kind/author contradicts the claim.
    if (id) return { ids: [id], limit: 1 };
    if (target.type !== "address") return;
    const address = parseThreadAddress(target.value);
    if (!address) return;
    return { kinds: [address.kind], authors: [address.pubkey],
        ...(address.kind >= 30000 ? { "#d": [address.identifier] } : {}), limit: 1 };
}
function targetMatches(a: RelationTarget, b: RelationTarget): boolean {
    return !!exactId(a) && exactId(a) === exactId(b) || a.type === b.type && a.value === b.value;
}
function relatedCandidate(event: Event, target: RelationTarget): boolean {
    const relations = normalizeThreadRelations(event);
    // Matching a raw #e/#a filter is discovery, not evidence of a parent edge.
    return [relations.parent, relations.root].some((claim) => claim.candidates.some((candidate) => targetMatches(candidate, target)));
}
function copyTarget(target: RelationTarget): RelationTarget {
    return { ...target, relays: [...target.relays], hints: [...target.hints] };
}
function copyFilter(filter: Filter): Filter {
    return Object.fromEntries(Object.entries(filter).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])) as Filter;
}
function yieldToBrowser(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, 0);
        signal.addEventListener("abort", finish, { once: true });
    });
}

/** One bounded metadata graph shared across views; event bodies stay in the read cache. */
export class DiscussionCoordinator {
    readonly limits: Readonly<DiscussionLimits>;
    private graph = createThreadGraph();
    private graphBatch = new Map<string, ThreadEvent>();
    private flushTimer?: ReturnType<typeof setTimeout>;
    private sessions = new Map<string, Session>();
    private handleCount = 0;
    private serial = 0;

    constructor(overrides: Partial<DiscussionLimits> = {}) {
        const limits = { ...DISCUSSION_LIMITS, ...overrides };
        for (const key of Object.keys(limits) as (keyof DiscussionLimits)[]) {
            if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > DISCUSSION_LIMITS[key]) throw new RangeError(`Invalid discussion limit: ${key}`);
        }
        this.limits = Object.freeze(limits);
    }

    open(options: { focusId: string; author?: string; seed?: Event; hints?: string[]; signal?: AbortSignal; onUpdate?: () => void }): DiscussionHandle {
        if (!/^[0-9a-f]{64}$/.test(options.focusId)) throw new TypeError("Invalid discussion focus ID");
        if (options.author && !/^[0-9a-f]{64}$/.test(options.author)) throw new TypeError("Invalid discussion author");
        if (options.signal?.aborted) throw options.signal.reason;
        if (this.handleCount >= this.limits.maxHandles) throw new Error("Discussion handle budget exhausted");
        let session = this.sessions.get(options.focusId);
        if (session?.state === "closed") throw new Error("Discussion is closing");
        if (!session) {
            if (this.sessions.size >= this.limits.maxSessions) throw new Error("Discussion session budget exhausted");
            if (!this.sessions.size) this.graph = createThreadGraph();
            session = { focusId: options.focusId, hints: [], until: Math.floor(Date.now() / 1000), handles: new Map(),
                observed: new Set(), sources: new Map(), targets: new Set(), lookups: new Map(), work: new Map(),
                routes: new Map(), cachedTargets: new Set(), queuedWork: { ancestor: 0, descendants: 0 }, turn: 0, limitations: new Set(), retentionLimited: false,
                requests: 0, receivedBytes: 0, state: "idle" };
            this.sessions.set(options.focusId, session);
        }
        session.focusAuthor ??= options.author;
        session.hints = relayCandidates([...session.hints, ...(options.hints ?? []).slice(0, 32)], this.limits.maxRelays);
        if (options.seed?.id === options.focusId) this.admit(session, options.seed);
        const current = session;
        const id = ++this.serial;
        current.handles.set(id, options.onUpdate); this.handleCount++;
        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true; options.signal?.removeEventListener("abort", close);
            current.handles.delete(id); this.handleCount--;
            if (current.handles.size) return;
            current.state = "closed"; current.controller?.abort("cancelled");
            if (!current.running) this.sessions.delete(current.focusId);
        };
        options.signal?.addEventListener("abort", close, { once: true });
        this.notify();
        return {
            snapshot: () => this.snapshot(current),
            loadMore: () => closed ? Promise.resolve(this.snapshot(current)) : this.load(current),
            close,
        };
    }

    private notify() {
        for (const session of this.sessions.values()) for (const callback of session.handles.values()) {
            try { callback?.(); } catch { /* A view cannot interrupt transport cleanup. */ }
        }
    }
    private satisfied(session: Session, work: DiscussionCoverage) {
        return work.purpose === "ancestor" && !!exactId(work.target) && session.observed.has(exactId(work.target)!);
    }
    private pending(session: Session, work: DiscussionCoverage) {
        return !work.exhausted && !work.truncated && !this.satisfied(session, work);
    }
    private canContinue(session: Session) {
        return session.requests < this.limits.maxRequests && !session.limitations.has("bytes") && !session.limitations.has("events");
    }
    private retryableRoute(route: Route) {
        return !route.fromCache && !route.read.length && !route.write.length && Object.values(route.relays).some((outcome) => outcome !== "eose");
    }
    private routingPending(session: Session) {
        return session.work.size < this.limits.maxBranches && [...session.routes.values()].some(route => !route.attempted || this.retryableRoute(route));
    }
    private snapshot(session: Session): DiscussionSnapshot {
        return { focusId: session.focusId, until: session.until, graph: this.graph, state: session.state,
            coverage: [...session.work.values()].map((work) => ({ ...work, target: copyTarget(work.target), filter: copyFilter(work.filter),
                cursor: work.cursor && { ...work.cursor, boundaryIds: [...work.cursor.boundaryIds] }, satisfied: this.satisfied(session, work) })),
            routing: [...session.routes.values()].map((route) => ({ author: route.author, read: [...route.read], write: [...route.write],
                relays: { ...route.relays }, fromCache: route.fromCache })),
            queuedWork: { ...session.queuedWork },
            limitations: [...session.limitations].sort(), stopReason: session.stopReason,
            retentionLimited: session.retentionLimited || this.graph.limited,
            observedEvents: session.observed.size, requests: session.requests, receivedBytes: session.receivedBytes,
            hasMore: session.state !== "closed" && this.canContinue(session) &&
                (session.state === "idle" || session.queuedWork.ancestor + session.queuedWork.descendants > 0 || [...session.work.values()].some((work) => this.pending(session, work)) ||
                    this.routingPending(session)) };
    }

    private flushGraph() {
        clearTimeout(this.flushTimer); this.flushTimer = undefined;
        if (!this.graphBatch.size) return;
        this.graph = reduceThreadGraph(this.graph, [...this.graphBatch.values()]);
        this.graphBatch.clear(); this.notify();
    }
    private admit(session: Session, input: Event, work?: DiscussionCoverage, source?: string, defer = false): boolean {
        if (session.state === "closed") return false;
        if (session.observed.has(input.id)) return false;
        const size = JSON.stringify(input).length * 3;
        if (size > this.limits.maxEventBytes) { session.limitations.add("event-size"); session.retentionLimited = true; return false; }
        const event = verifiedNostrEvent(input);
        if (!event) return false;
        return this.retain(session, event, work, source, defer);
    }
    /** Internal admission only after fresh verification above or in query(). */
    private retain(session: Session, event: Event, work?: DiscussionCoverage, source?: string, defer = false): boolean {
        if (session.state === "closed" || work && (!matchFilter(work.filter, event) || work.purpose === "descendants" && !relatedCandidate(event, work.target))) return false;
        if (source) {
            const sources = session.sources.get(event.id) ?? [];
            if (session.observed.has(event.id)) session.sources.set(event.id, relayCandidates([...sources, source], this.limits.maxRelays));
        }
        if (session.observed.has(event.id)) return false;
        if (session.observed.size >= this.limits.maxEvents) { session.limitations.add("events"); session.retentionLimited = true; return false; }
        session.observed.add(event.id);
        if (source) session.sources.set(event.id, [source]);
        nostrCache.put(event);
        this.graphBatch.set(event.id, { id: event.id, pubkey: event.pubkey, kind: event.kind, created_at: event.created_at, tags: event.tags });
        if (!defer || this.graphBatch.size >= 32) this.flushGraph();
        else this.flushTimer ??= setTimeout(() => this.flushGraph(), 16);
        return true;
    }

    private route(session: Session, author: string | undefined, hints: string[] = []) {
        if (!author) return;
        const existing = session.routes.get(author);
        if (existing) {
            const combined = relayCandidates([...existing.hints, ...hints], this.limits.maxRelays);
            if (!existing.fromCache && !existing.read.length && !existing.write.length && combined.length > existing.hints.length) existing.attempted = false;
            existing.hints = combined;
            return existing;
        }
        if (session.routes.size >= this.limits.maxAuthors) { session.limitations.add("authors"); return; }
        const cached = nostrCache.query({ kinds: [10002], authors: [author], limit: 1 })[0];
        const route: Route = { author, read: [], write: [], relays: {}, fromCache: !!cached, attempted: !!cached,
            hints: relayCandidates(hints, this.limits.maxRelays) };
        if (cached) this.applyRoute(route, cached);
        session.routes.set(author, route);
        return route;
    }
    private applyRoute(route: Route, event: Event) {
        const relays = (direction: string) => relayCandidates(event.tags.filter((tag) => tag[0] === "r" && (!tag[2] || tag[2] === direction))
            .slice(0, 128).map((tag) => tag[1]), 4);
        route.read = relays("read"); route.write = relays("write");
    }
    private sources(session: Session, target: RelationTarget, purpose: DiscussionCoverage["purpose"]) {
        const route = target.author && session.routes.get(target.author);
        const fallback = relayCandidates([RELAY_URL, ...PUBLIC_RELAYS], 3);
        const hints = relayCandidates([...target.relays, ...session.hints], 4);
        const observed = session.sources.get(exactId(target) ?? "") ?? [];
        // Public reply destinations and productive sources matter especially
        // when the board relay omits unpaid notes. Interleave bounded groups.
        const groups = purpose === "ancestor" ? [fallback, route ? route.write : [], hints, observed] :
            [route ? route.read : [], observed, fallback, hints];
        const candidates = relayCandidates(Array.from({ length: 4 }, (_, index) => groups.map((group) => group[index])).flat().filter(Boolean));
        if (candidates.length > this.limits.maxRelays) session.limitations.add("relays");
        return candidates.slice(0, this.limits.maxRelays);
    }
    /** Claims are candidates only; graph normalization still decides every edge. */
    private lookupCandidates(session: Session) {
        const candidates = new Map<string, Lookup & { critical: boolean }>();
        const add = (target: RelationTarget, critical: boolean) => {
            if (exactId(target) && session.observed.has(exactId(target)!)) return;
            const filter = lookupFilter(target);
            if (!filter) return; // External scopes never become URL fetches.
            const key = lookupKey(target), old = candidates.get(key);
            if (old) {
                old.target.relays = relayCandidates([...old.target.relays, ...target.relays], this.limits.maxRelays);
                old.target.author ??= target.author;
                old.critical ||= critical;
            } else candidates.set(key, { target: copyTarget(target), filter, critical });
        };
        if (!session.observed.has(session.focusId)) add({ ...exactTarget(session.focusId), author: session.focusAuthor }, true);
        // Resolve the promoted item's own context before unrelated missing parents.
        const path = new Set<string>();
        let node = this.graph.nodes.get(`event:${session.focusId}`);
        while (node && path.size < this.graph.limits.maxDepth && !path.has(node.key)) {
            path.add(node.key);
            for (const claim of [node.relations?.parent, node.relations?.root]) if (claim?.state === "valid") add(claim.target!, true);
            node = node.parent ? this.graph.nodes.get(node.parent) : undefined;
        }
        for (const id of session.observed) {
            const current = this.graph.nodes.get(`event:${id}`);
            for (const claim of [current?.relations?.parent, current?.relations?.root]) if (claim?.state === "valid") add(claim.target!, false);
        }
        // Preserve retries and hints for admitted work even if a graph eviction
        // removes the claim that originally discovered it.
        for (const lookup of session.lookups.values()) add(lookup.target, false);
        return candidates;
    }
    private descendantCandidates(session: Session) {
        const queue = [{ id: session.focusId, depth: 0 }], visited = new Set<string>();
        const candidates: { id: string; depth: number; scopes: { target: RelationTarget; filter: Filter }[] }[] = [];
        for (let index = 0; index < queue.length && index < this.graph.limits.maxNodes; index++) {
            const { id, depth } = queue[index];
            if (visited.has(id)) continue;
            visited.add(id);
            const event = this.graph.events.get(id);
            if (!event) continue;
            for (const key of this.graph.children.get(`event:${id}`) ?? []) {
                const child = this.graph.nodes.get(key)?.event;
                if (child && queue.length < this.graph.limits.maxNodes) queue.push({ id: child.id, depth: depth + 1 });
            }
            const target: RelationTarget = { ...exactTarget(id), author: event.pubkey, kind: event.kind };
            const scopes: { target: RelationTarget; filter: Filter }[] = [
                { target, filter: { kinds: event.kind === 1 ? [1, 1111] : [1111], "#e": [id] } },
                { target, filter: { kinds: [1111], "#E": [id] } },
            ];
            const address = replaceableKey({ ...event, content: "", sig: "" });
            if (address) {
                const scope = { ...target, type: "address" as const, value: address, exactId: id };
                scopes.push({ target: scope, filter: { kinds: [1111], "#a": [address] } },
                    { target: scope, filter: { kinds: [1111], "#A": [address] } });
            }
            candidates.push({ id, depth, scopes });
        }
        return candidates;
    }
    private hydrate(session: Session) {
        // Cache hydration has its own finite scan allowance. A cache hit never
        // reserves a missing-parent lookup or a network descendant target.
        for (let pass = 0; pass <= this.limits.maxLookups; pass++) {
            let changed = false, lookups = 0;
            for (const lookup of this.lookupCandidates(session).values()) {
                if (lookups++ >= this.limits.maxLookups) break;
                for (const event of nostrCache.query(lookup.filter)) changed = this.admit(session, event, undefined, undefined, true) || changed;
            }
            this.flushGraph();
            for (const candidate of this.descendantCandidates(session)) {
                if (session.cachedTargets.has(candidate.id) || session.cachedTargets.size >= this.limits.maxTargets) continue;
                session.cachedTargets.add(candidate.id);
                for (const scope of candidate.scopes) {
                    const work = { ...scope, purpose: "descendants" } as DiscussionCoverage;
                    for (const event of nostrCache.query({ ...scope.filter, limit: this.limits.maxEvents + 1 })) changed = this.admit(session, event, work, undefined, true) || changed;
                }
            }
            this.flushGraph();
            if (!changed || session.limitations.has("events")) break;
        }
    }
    private plan(session: Session, blocked: ReadonlySet<string>): PlannedWork | undefined {
        this.hydrate(session);
        session.queuedWork = { ancestor: 0, descendants: 0 };
        const best = new Map<WorkClass, PlannedWork>();
        const seen = new Set<string>();
        const sourceCounts = new Map<string, number>();
        for (const work of session.work.values()) {
            const prefix = JSON.stringify([work.purpose, lookupKey(work.target), work.filter]);
            sourceCounts.set(prefix, (sourceCounts.get(prefix) ?? 0) + 1);
        }
        const consider = (work: DiscussionCoverage, group: WorkClass, rank: number[]) => {
            if (seen.has(work.key)) return;
            seen.add(work.key);
            if (!this.pending(session, work)) return;
            if (!session.work.has(work.key)) session.queuedWork[work.purpose]++;
            if (blocked.has(work.key)) return;
            const previous = best.get(group);
            if (!previous || compareRank(rank, previous.rank) < 0) best.set(group, { work, group, rank });
        };
        const candidate = (target: RelationTarget, purpose: DiscussionCoverage["purpose"], filter: Filter, group: WorkClass, depth: number, order: number, predicate: number) => {
            const admitted = purpose === "ancestor" ? session.lookups.has(lookupKey(target)) : session.targets.has(exactId(target)!);
            if (!admitted && (purpose === "ancestor" ? session.lookups.size >= this.limits.maxLookups : session.targets.size >= this.limits.maxTargets)) {
                session.limitations.add(purpose === "ancestor" ? "lookups" : "targets"); return;
            }
            const prefix = JSON.stringify([purpose, lookupKey(target), filter]);
            const sourceCount = sourceCounts.get(prefix) ?? 0;
            const sources = this.sources(session, target, purpose);
            for (const [source, relay] of sources.entries()) {
                const key = JSON.stringify([purpose, lookupKey(target), filter, relay]);
                const old = session.work.get(key);
                if (!old && sourceCount >= this.limits.maxRelays) { session.limitations.add("relays"); continue; }
                if (!old && session.work.size >= this.limits.maxBranches) { session.limitations.add("branches"); continue; }
                const work = old ?? { key, purpose, target, relay, filter, pages: 0, exhausted: false, truncated: false, satisfied: false };
                // Spread primary checks across each breadth level before trying
                // its alternative predicates and fallback relays.
                consider(work, group, [work.pages, depth, predicate, source, order]);
            }
        };
        let order = 0;
        for (const lookup of this.lookupCandidates(session).values()) candidate(lookup.target, "ancestor", lookup.filter, lookup.critical ? "critical" : "ancestors", 0, order++, 0);
        order = 0;
        for (const target of this.descendantCandidates(session)) {
            target.scopes.forEach((scope, index) => candidate(scope.target, "descendants", scope.filter, target.id === session.focusId ? "focus" : "replies", target.depth, order, index));
            order++;
        }
        // Admitted retries survive changing routing/graph metadata. They retain
        // their own cursor; a failed source is blocked only in the current batch.
        for (const work of session.work.values()) consider(work, work.purpose === "ancestor" ? "ancestors" : exactId(work.target) === session.focusId ? "focus" : "replies", [work.pages, this.graph.limits.maxDepth, 0, 0, order++]);
        if (best.has("critical")) return best.get("critical");
        for (let offset = 0; offset < WORK_TURNS.length; offset++) {
            const group = WORK_TURNS[(session.turn + offset) % WORK_TURNS.length];
            if (best.has(group)) return best.get(group);
        }
    }
    private admitWork(session: Session, work: DiscussionCoverage) {
        const existing = session.work.get(work.key);
        if (existing) return existing;
        if (work.purpose === "ancestor") session.lookups.set(lookupKey(work.target), { target: copyTarget(work.target), filter: copyFilter(work.filter) });
        else session.targets.add(exactId(work.target)!);
        const admitted = { ...work, target: copyTarget(work.target), filter: copyFilter(work.filter) };
        session.work.set(work.key, admitted);
        session.queuedWork[work.purpose] = Math.max(0, session.queuedWork[work.purpose] - 1);
        return admitted;
    }

    private load(session: Session): Promise<DiscussionSnapshot> {
        if (session.running) return session.running;
        if (!this.canContinue(session)) return Promise.resolve(this.snapshot(session));
        const controller = new AbortController();
        session.controller = controller; session.state = "loading"; session.stopReason = undefined;
        const timer = setTimeout(() => controller.abort("timeout"), this.limits.runTimeout);
        session.running = this.run(session, controller).finally(() => {
            clearTimeout(timer); controller.abort(); session.controller = undefined; session.running = undefined;
            if (session.state === "closed") this.sessions.delete(session.focusId);
            this.notify();
        }).then(() => this.snapshot(session));
        this.notify();
        return session.running;
    }
    private async run(session: Session, controller: AbortController) {
        const blocked = new Set<string>();
        let requests = 0;
        try {
            await new Promise<void>((resolve, reject) => {
                const abort = () => reject(controller.signal.reason);
                controller.signal.addEventListener("abort", abort, { once: true });
                nostrCache.ready.then(() => { controller.signal.removeEventListener("abort", abort); resolve(); }, reject);
            });
            for (const route of session.routes.values()) if (this.retryableRoute(route)) route.attempted = false;
            while (!controller.signal.aborted) {
                const planned = this.plan(session, blocked);
                if (controller.signal.aborted) break;
                // Metadata discovery belongs to selected work, rather than every
                // author on the unsent frontier. Failed discovery still retries.
                let route = planned?.work.target.author ? session.routes.get(planned.work.target.author) : undefined;
                if (!planned && session.work.size < this.limits.maxBranches) route = [...session.routes.values()].find(route => !route.attempted);
                if (!planned && !route) break;
                if (!this.canContinue(session)) {
                    session.stopReason = session.limitations.has("events") ? "events" : session.limitations.has("bytes") ? "bytes" : "requests";
                    if (session.stopReason === "requests") session.limitations.add("requests");
                    break;
                }
                if (requests >= this.limits.requestsPerRun) { session.stopReason = "batch"; break; }
                const hadRoute = !!route;
                if (session.work.size >= this.limits.maxBranches) route = undefined;
                else if (planned) route = this.route(session, planned.work.target.author,
                    planned.work.purpose === "ancestor" ? planned.work.target.relays : session.sources.get(exactId(planned.work.target) ?? ""));
                if (route && route.attempted) route = undefined;
                // A newly admitted cached route can change the source order.
                // Replan before creating the coverage record.
                const cachedRouteAdded = !hadRoute && planned?.work.target.author && session.routes.get(planned.work.target.author)?.fromCache;
                const selected = route ? undefined : cachedRouteAdded ? this.plan(session, blocked) : planned;
                if (controller.signal.aborted || !route && !selected) break;
                requests++; session.requests++;
                if (route) {
                    route.attempted = true;
                    const filter = { kinds: [10002], authors: [route.author], limit: 1 };
                    const urls = relayCandidates([...DISCOVERY_RELAYS, ...route.hints.slice(0, 2), ...session.hints.slice(0, 2), ...PUBLIC_RELAYS], this.limits.maxRelays);
                    const result = await this.query(session, filter, urls, controller);
                    route.relays = result.relays;
                    const latest = result.events.reduce<Event | undefined>((old, event) => newerEvent(event, old) ? event : old, undefined);
                    if (latest) this.applyRoute(route, latest);
                } else {
                    const work = this.admitWork(session, selected!.work);
                    if (selected!.group !== "critical") {
                        while (WORK_TURNS[session.turn % WORK_TURNS.length] !== selected!.group) session.turn++;
                        session.turn = (session.turn + 1) % WORK_TURNS.length;
                    }
                    const filter = { ...work.filter, until: work.purpose === "descendants" ? work.cursor?.until ?? session.until : undefined,
                        limit: work.purpose === "descendants" ? work.cursor?.limit ?? this.limits.pageSize : 1 };
                    const result = await this.query(session, filter, [work.relay], controller, work);
                    work.outcome = result.relays[work.relay]; work.pages++;
                    if (work.purpose === "ancestor") work.exhausted = result.complete;
                    else {
                        const page = historyPageResult(result, filter.limit, work.cursor);
                        work.exhausted = page.exhausted; work.truncated ||= page.truncated && result.complete;
                        if (page.next) work.cursor = page.next;
                        if (page.truncated && result.complete) session.limitations.add("pages");
                        if (!work.exhausted && work.pages >= this.limits.maxPages) { work.truncated = true; session.limitations.add("pages"); }
                    }
                    if (!result.complete) blocked.add(work.key);
                }
                this.notify();
                // Allow deadlines, navigation and other readers to run even
                // when a source resolves entirely from already queued events.
                await yieldToBrowser(controller.signal);
            }
        } catch {
            if (!controller.signal.aborted) session.stopReason = "error";
        } finally {
            if (controller.signal.aborted) session.stopReason = controller.signal.reason as StopReason;
            const unfinished = session.queuedWork.ancestor + session.queuedWork.descendants > 0 ||
                [...session.work.values()].some(work => this.pending(session, work)) || this.routingPending(session);
            if (session.state !== "closed" && unfinished && session.requests >= this.limits.maxRequests) {
                session.limitations.add("requests"); session.stopReason ??= "requests";
            }
            if (session.state !== "closed") session.state = session.stopReason || unfinished ? "paused" : "settled";
        }
    }

    private async query(session: Session, filter: Filter, urls: string[], controller: AbortController, work?: DiscussionCoverage): Promise<QueryResult> {
        const events = new Map<string, Event>();
        let limited = false;
        const receive = (input: Event) => {
            if (controller.signal.aborted || events.has(input.id)) return;
            const size = JSON.stringify(input).length * 3;
            if (size > this.limits.maxEventBytes) { limited = true; session.limitations.add("event-size"); session.retentionLimited = true; return; }
            if (session.receivedBytes + size > this.limits.maxBytes) {
                limited = true; session.limitations.add("bytes"); controller.abort("bytes"); return;
            }
            const event = verifiedNostrEvent(input);
            if (!event || !matchFilter(filter, event)) return;
            session.receivedBytes += size;
            if (events.size >= 512) { limited = true; return; }
            events.set(event.id, event);
            if (!work || !this.retain(session, event, work, work.relay, true)) nostrCache.put(event);
            if (session.limitations.has("events")) controller.abort("events");
        };
        try {
            const result = await withReadBudget(controller.signal, () => queryNostr(filter, urls, {
                signal: controller.signal, timeout: this.limits.queryTimeout,
                first: work?.purpose === "ancestor" && !!exactId(work.target),
                priority: work?.purpose === "ancestor" ? 2 : 0, onEvent: receive,
            }));
            for (const event of result.events.slice(0, 512)) receive(event);
            if (result.events.length > 512) limited = true;
            if (limited && work) work.truncated = true;
            const relays = Object.fromEntries(urls.map((url) => [url, limited ? "budget" as const : result.relays[url] ?? "error"]));
            return { events: [...events.values()].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)),
                sources: Object.fromEntries([...events.keys()].map((id) => [id, work ? [work.relay] : result.sources[id] ?? []])),
                relays, complete: urls.length > 0 && Object.values(relays).every((outcome) => outcome === "eose") };
        } catch {
            if (limited && work) work.truncated = true;
            const outcome: RelayOutcome = limited ? "budget" : controller.signal.aborted ? controller.signal.reason === "timeout" ? "timeout" : "cancelled" : "error";
            return { events: [...events.values()], sources: {}, relays: Object.fromEntries(urls.map((url) => [url, outcome])), complete: false };
        } finally { this.flushGraph(); }
    }
}

export const discussionCoordinator = new DiscussionCoordinator();
