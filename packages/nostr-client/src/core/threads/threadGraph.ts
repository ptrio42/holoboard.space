import type { Event } from "nostr-tools";
import { normalizeThreadRelations, relationKey, type RelationClaim, type RelationTarget, type ThreadRelations } from "./threadRelations";

/** Metadata from the verified read layer. This module is not a network ingress. */
export type ThreadEvent = Pick<Event, "id" | "pubkey" | "created_at" | "kind" | "tags">;
export interface ThreadGraphLimits {
    maxEvents: number;
    maxNodes: number;
    maxBytes: number;
    maxEventBytes: number;
    maxBatch: number;
    maxDepth: number;
}
export const THREAD_GRAPH_LIMITS: Readonly<ThreadGraphLimits> = Object.freeze({
    maxEvents: 2048, maxNodes: 6144, maxBytes: 8 * 1024 * 1024,
    maxEventBytes: 256 * 1024, maxBatch: 512, maxDepth: 128,
});

export type ParentState = "none" | "resolved" | "missing" | "external" | "invalid" | "conflict" | "cycle" | "budget";
export type RootState = "none" | "matched" | "unresolved" | "invalid" | "conflict" | "depth-limit" | "budget";
export interface ThreadNode {
    key: string;
    reference: RelationTarget;
    event?: ThreadEvent;
    relations?: ThreadRelations;
    /** Declared/resolved lookup key, retained even when the edge is rejected. */
    claimedParent?: string;
    parent?: string;
    parentState: ParentState;
    rootState: RootState;
    issues: string[];
}
export interface ThreadGraph {
    events: ReadonlyMap<string, ThreadEvent>;
    nodes: ReadonlyMap<string, ThreadNode>;
    children: ReadonlyMap<string, readonly string[]>;
    aliases: ReadonlyMap<string, string>;
    limits: Readonly<ThreadGraphLimits>;
    /** Sticky local retention loss. It says nothing about network completeness. */
    limited: boolean;
    bytes: number;
}

const eventKey = (id: string) => `event:${id}`;
const eventTarget = (event: ThreadEvent): RelationTarget => ({ type: "event", value: event.id,
    kind: event.kind, author: event.pubkey, relays: [], hints: [] });

function addressOf(event: ThreadEvent): string | undefined {
    if (event.kind === 0 || event.kind === 3 || event.kind >= 10000 && event.kind < 20000) return `${event.kind}:${event.pubkey}:`;
    if (event.kind >= 30000 && event.kind < 40000) return `${event.kind}:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1] ?? ""}`;
}

function mismatch(target: RelationTarget, claim: RelationClaim, event: ThreadEvent): string | undefined {
    if (target.kind !== undefined && target.kind !== event.kind) return "kind-conflict";
    if (target.author && target.author !== event.pubkey || claim.authors.length && !claim.authors.includes(event.pubkey)) return "author-conflict";
    if (target.type === "address" && addressOf(event) !== target.value) return "address-conflict";
    if (target.type === "event" && target.value !== event.id || target.exactId && target.exactId !== event.id) return "id-conflict";
}

/** Undefined means an ID/address comparison needs the missing signed event. */
function sameScope(a: RelationTarget, b: RelationTarget, events: ReadonlyMap<string, ThreadEvent>): boolean | undefined {
    if (a.kind !== undefined && b.kind !== undefined && a.kind !== b.kind || a.author && b.author && a.author !== b.author) return false;
    if (a.type === b.type) return a.value === b.value && !(a.exactId && b.exactId && a.exactId !== b.exactId);
    if (a.type === "external" || b.type === "external") return false;
    const address = a.type === "address" ? a : b, exact = a.type === "event" ? a : b;
    if (address.exactId) return address.exactId === exact.value;
    const event = events.get(exact.value);
    return event ? addressOf(event) === address.value : undefined;
}

export function createThreadGraph(overrides: Partial<ThreadGraphLimits> = {}): ThreadGraph {
    const limits = { ...THREAD_GRAPH_LIMITS, ...overrides };
    for (const name of Object.keys(limits) as (keyof ThreadGraphLimits)[]) {
        if (!Number.isSafeInteger(limits[name]) || limits[name] < 1 || limits[name] > THREAD_GRAPH_LIMITS[name]) throw new RangeError(`Invalid thread graph limit: ${name}`);
    }
    return { events: new Map(), nodes: new Map(), children: new Map(), aliases: new Map(),
        limits: Object.freeze(limits), limited: false, bytes: 0 };
}

/**
 * Pure bounded reducer. Callers verify signatures before admission and share one
 * store across views. Retention is an ID-sorted prefix, never an arrival-order LRU.
 * Batches larger than maxBatch must be split by the caller; loss is explicit.
 */
export function reduceThreadGraph(previous: ThreadGraph, batch: readonly ThreadEvent[]): ThreadGraph {
    const { limits } = previous;
    let limited = previous.limited || batch.length > limits.maxBatch;
    const candidates = new Map(previous.events);
    for (const input of batch.slice(0, limits.maxBatch)) {
        // Copy only relation metadata; content and signatures stay in the read store.
        if (candidates.has(input.id)) continue;
        const event = { id: input.id, pubkey: input.pubkey, kind: input.kind,
            created_at: input.created_at, tags: input.tags };
        if (JSON.stringify(event).length * 3 > limits.maxEventBytes) { limited = true; continue; }
        candidates.set(event.id, event);
    }
    let bytes = 0;
    const events = new Map<string, ThreadEvent>();
    for (const [id, event] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
        const size = JSON.stringify(event).length * 3;
        if (events.size >= Math.min(limits.maxEvents, limits.maxNodes) || bytes + size > limits.maxBytes) { limited = true; break; }
        if (previous.events.has(id)) events.set(id, event);
        else {
            const retained = { ...event, tags: event.tags.map((tag) => Object.freeze([...tag]) as string[]) };
            Object.freeze(retained.tags);
            events.set(id, Object.freeze(retained));
        }
        bytes += size;
    }
    const aliases = new Map<string, string>();
    const nodes = new Map<string, ThreadNode>();
    for (const event of events.values()) {
        const address = addressOf(event);
        if (address) {
            const old = events.get(aliases.get(address) ?? "");
            if (!old || event.created_at > old.created_at || event.created_at === old.created_at && event.id < old.id) aliases.set(address, event.id);
        }
        const key = eventKey(event.id);
        nodes.set(key, { key, event, reference: eventTarget(event), relations: normalizeThreadRelations(event),
            parentState: "none", rootState: "none", issues: [] });
    }
    function resolve(target: RelationTarget): string | undefined {
        const key = target.type === "event" ? eventKey(target.value) : target.exactId ? eventKey(target.exactId) :
            target.type === "address" && aliases.has(target.value) ? eventKey(aliases.get(target.value)!) : relationKey(target);
        if (!nodes.has(key)) {
            if (nodes.size >= limits.maxNodes) { limited = true; return; }
            nodes.set(key, { key, reference: target, parentState: "none", rootState: "none", issues: [] });
        }
        return key;
    }
    const rootKeys = new Map<string, string>();
    for (const node of [...nodes.values()]) {
        const { root, parent } = node.relations!;
        if (root.state === "valid") {
            const key = resolve(root.target!);
            node.rootState = key ? "unresolved" : "budget";
            if (key) {
                rootKeys.set(node.key, key);
                const loaded = nodes.get(key)?.event;
                const problem = loaded && mismatch(root.target!, root, loaded);
                if (problem) { node.rootState = "conflict"; node.issues.push(`root:${problem}`); }
            }
        } else if (root.state !== "absent") node.rootState = root.state;
        if (parent.state === "absent") continue;
        if (parent.state !== "valid") { node.parentState = parent.state; continue; }
        const key = resolve(parent.target!);
        node.claimedParent = key;
        if (!key) { node.parentState = "budget"; continue; }
        const targetNode = nodes.get(key)!;
        const problem = targetNode.event && mismatch(parent.target!, parent, targetNode.event);
        if (problem) { node.parentState = "conflict"; node.issues.push(`parent:${problem}`); continue; }
        node.parent = key;
        node.parentState = targetNode.event ? "resolved" : parent.target!.type === "external" ? "external" : "missing";
    }
    // Reject every edge in a cycle, rather than making the cut depend on focus or arrival.
    const checked = new Set<string>();
    for (const start of nodes.keys()) {
        const path: string[] = [], positions = new Map<string, number>();
        let key: string | undefined = start;
        while (key && !checked.has(key)) {
            const position = positions.get(key);
            if (position !== undefined) {
                for (const cyclicKey of path.slice(position)) {
                    const cyclic = nodes.get(cyclicKey)!;
                    cyclic.parent = undefined; cyclic.parentState = "cycle";
                    cyclic.issues.push("parent:cycle");
                }
                break;
            }
            positions.set(key, path.length); path.push(key);
            key = nodes.get(key)?.parent;
        }
        for (const visited of path) checked.add(visited);
    }
    // A root claim is evidence to check, never a second parent edge.
    for (const node of nodes.values()) {
        if (node.rootState !== "unresolved") continue;
        const rootKey = rootKeys.get(node.key)!;
        const rootClaim = node.relations!.root;
        const target = rootClaim.target!;
        let current = node;
        let depth = 0;
        while (current.parent && depth < limits.maxDepth) {
            current = nodes.get(current.parent)!; depth++;
            const ancestorRoot = current.relations?.root.target;
            if (ancestorRoot && sameScope(target, ancestorRoot, events) === false) {
                node.rootState = "conflict"; node.issues.push("root:declared-scope-conflict"); break;
            }
        }
        if (node.rootState === "conflict") continue;
        if (current.parent) { node.rootState = "depth-limit"; continue; }
        if (current.parentState !== "none") continue;
        if (current.event) {
            const problem = mismatch(target, rootClaim, current.event);
            node.rootState = problem ? "conflict" : "matched";
            if (problem) node.issues.push("root:ancestry-conflict");
        } else if (target.type === "external" && current.reference.type === "external") {
            node.rootState = current.key === rootKey && target.kind === current.reference.kind ? "matched" : "conflict";
        }
    }
    const children = new Map<string, string[]>();
    for (const node of nodes.values()) {
        if (!node.parent) continue;
        const siblings = children.get(node.parent) ?? [];
        siblings.push(node.key); children.set(node.parent, siblings);
    }
    for (const siblings of children.values()) siblings.sort();
    return { events, nodes: new Map([...nodes].sort(([a], [b]) => a.localeCompare(b))),
        children: new Map([...children].sort(([a], [b]) => a.localeCompare(b))),
        aliases: new Map([...aliases].sort(([a], [b]) => a.localeCompare(b))), limits, limited, bytes };
}

export interface ThreadRow { key: string; depth: number; visibility: "visible" | "missing" | "hidden" | "deleted" }
export interface ThreadProjectionOptions {
    hiddenIds?: ReadonlySet<string>;
    deletedIds?: ReadonlySet<string>;
    compareSiblings?: (a: ThreadNode, b: ThreadNode) => number;
}

/** Focus is an exact event ID, independent of protocol root and promotion status. */
export function projectThread(graph: ThreadGraph, focusId: string, options: ThreadProjectionOptions = {}) {
    const focusKey = eventKey(focusId);
    const row = (key: string, depth: number): ThreadRow => {
        const event = graph.nodes.get(key)?.event;
        const visibility = !event ? "missing" : options.deletedIds?.has(event.id) ? "deleted" : options.hiddenIds?.has(event.id) ? "hidden" : "visible";
        return { key, depth, visibility };
    };
    const ancestors: ThreadRow[] = [];
    let current = graph.nodes.get(focusKey);
    let ancestorStop: ParentState | "depth-limit" = current ? "none" : "missing";
    const visited = new Set<string>([focusKey]);
    while (current) {
        ancestorStop = current.parentState;
        if (!current.parent) break;
        if (ancestors.length >= graph.limits.maxDepth) { ancestorStop = "depth-limit"; break; }
        if (visited.has(current.parent)) { ancestorStop = "cycle"; break; }
        visited.add(current.parent);
        ancestors.push(row(current.parent, 0));
        current = graph.nodes.get(current.parent);
        if (!current?.event) { ancestorStop = current?.reference.type === "external" ? "external" : "missing"; break; }
    }
    const replies: ThreadRow[] = [];
    let truncated = graph.limited || ancestorStop === "depth-limit";
    const compare = (a: string, b: string) => (options.compareSiblings?.(graph.nodes.get(a)!, graph.nodes.get(b)!) ?? 0) || a.localeCompare(b);
    const childrenOf = (key: string) => [...(graph.children.get(key) ?? [])].sort(compare);
    const pending = childrenOf(focusKey).reverse().map((key) => ({ key, depth: 1 }));
    visited.clear(); visited.add(focusKey);
    while (pending.length) {
        const next = pending.pop()!;
        if (visited.has(next.key)) continue;
        visited.add(next.key); replies.push(row(next.key, next.depth));
        const children = childrenOf(next.key);
        if (next.depth >= graph.limits.maxDepth) { if (children.length) truncated = true; continue; }
        for (const key of children.reverse()) pending.push({ key, depth: next.depth + 1 });
    }
    return { focus: row(focusKey, 0), ancestors: ancestors.reverse(), replies, ancestorStop, truncated,
        loadedReplyCount: replies.filter((entry) => !!graph.nodes.get(entry.key)?.event).length };
}
