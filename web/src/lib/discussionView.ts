import type { DiscussionCoverage, DiscussionSnapshot } from "./discussionReads";
import { projectThread, type ThreadGraph, type ThreadNode, type ThreadRow } from "./threadGraph";

export const DISCUSSION_PAGE_SIZE = 48;
export { boardReturnPath, discussionRoute, discussionHref } from "./readingRoutes";
/** Chronology orders siblings only. Promotion and author identity cannot change edges. */
export const chronologicalReplies = (a: ThreadNode, b: ThreadNode) =>
    (a.event?.created_at ?? 0) - (b.event?.created_at ?? 0);
export function discussionProjection(graph: ThreadGraph, focusId: string) {
    const options = { compareSiblings: chronologicalReplies };
    const thread = projectThread(graph, focusId, options);
    const placed = new Set([thread.focus.key, ...thread.ancestors.map(row => row.key), ...thread.replies.map(row => row.key)]);
    // An unresolved root claim remains a separate branch, never a parent edge.
    const unresolved: ThreadRow[] = [];
    for (const node of [...graph.nodes.values()].sort((a, b) => chronologicalReplies(a, b) || a.key.localeCompare(b.key))) {
        if (!node.event || placed.has(node.key) || node.relations?.root.state !== "valid") continue;
        const root = node.relations.root.target!;
        if (root.type === "external") continue;
        const rootKey = root.exactId ? `event:${root.exactId}` : root.type === "event" ? `event:${root.value}` : (graph.aliases.has(root.value) ? `event:${graph.aliases.get(root.value)}` : undefined);
        if (rootKey !== thread.focus.key) continue;
        let start = node;
        const visited = new Set<string>();
        while (start.parent && !placed.has(start.parent) && !visited.has(start.parent) && visited.size < graph.limits.maxDepth) {
            visited.add(start.key);
            const parent = graph.nodes.get(start.parent);
            if (!parent?.event) break;
            start = parent;
        }
        const branch = projectThread(graph, start.event!.id, options);
        for (const row of [{ ...branch.focus, depth: 1 }, ...branch.replies.map(row => ({ ...row, depth: row.depth + 1 }))]) {
            if (!placed.has(row.key)) { unresolved.push(row); placed.add(row.key); }
        }
    }
    return { ...thread, unresolved };
}
export function expandedReplies(rows: readonly ThreadRow[], expanded: ReadonlySet<string>) {
    const open = [true];
    return rows.filter(row => {
        const visible = open[row.depth - 1] === true;
        open[row.depth] = visible && expanded.has(row.key);
        open.length = row.depth + 1;
        return visible;
    });
}
/** Newly found branches open automatically; only an explicit collapse hides them. */
export function defaultExpansion(graph: ThreadGraph, collapsed: ReadonlySet<string>) {
    return new Set([...graph.nodes.keys()].filter(key => !collapsed.has(key)));
}
export type CoverageState = "found" | "finished" | "limited" | "retry" | "queued" | "more";
/** Work records describe coverage, not currently open subscriptions. */
export function coverageState(work: DiscussionCoverage): CoverageState {
    if (work.satisfied) return "found";
    if (work.truncated) return "limited";
    if (work.exhausted) return "finished";
    if (work.outcome && !["eose", "found"].includes(work.outcome)) return "retry";
    return work.pages > 0 ? "more" : "queued";
}
export function coverageCounts(work: readonly DiscussionCoverage[]) {
    const counts: Record<CoverageState, number> = { found: 0, finished: 0, limited: 0, retry: 0, queued: 0, more: 0 };
    for (const item of work) counts[coverageState(item)]++;
    return counts;
}
export function discussionSources(snapshot: DiscussionSnapshot) {
    const sources = new Map<string, { relay: string; work: DiscussionCoverage[]; discovery: number; discoveryFailed: number; discoveryOutcomes: Record<string, number>; inbox: number; outbox: number }>();
    const get = (relay: string) => {
        let source = sources.get(relay);
        if (!source) { source = { relay, work: [], discovery: 0, discoveryFailed: 0, discoveryOutcomes: {}, inbox: 0, outbox: 0 }; sources.set(relay, source); }
        return source;
    };
    for (const work of snapshot.coverage) get(work.relay).work.push(work);
    for (const route of snapshot.routing) for (const [relay, outcome] of Object.entries(route.relays)) {
        const source = get(relay);
        source.discovery++;
        source.discoveryOutcomes[outcome] = (source.discoveryOutcomes[outcome] ?? 0) + 1;
        if (outcome !== "eose") source.discoveryFailed++;
    }
    for (const source of sources.values()) for (const route of snapshot.routing) {
        if (route.read.includes(source.relay)) source.inbox++;
        if (route.write.includes(source.relay)) source.outbox++;
    }
    return [...sources.values()].sort((a, b) => a.relay.localeCompare(b.relay));
}
export function discussionCoverage(snapshot: DiscussionSnapshot) {
    const failed = snapshot.coverage.filter(work => work.outcome && !["eose", "found"].includes(work.outcome) && !work.satisfied).length;
    const queued = (snapshot.queuedWork?.ancestor ?? 0) + (snapshot.queuedWork?.descendants ?? 0);
    const pending = queued + snapshot.coverage.filter(work => !work.exhausted && !work.truncated && !work.satisfied).length;
    const routingFailed = snapshot.routing.some(route => Object.values(route.relays).some(outcome => outcome !== "eose"));
    const limited = snapshot.retentionLimited || snapshot.limitations.length > 0;
    return { failed, pending, limited, partial: failed > 0 || routingFailed || limited || pending > 0 || snapshot.state === "paused" };
}
