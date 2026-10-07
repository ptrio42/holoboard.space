import type { DiscussionSnapshot } from "./discussionReads";
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
/** Keep a previously opened branch visible when a late parent changes its path. */
export function expansionPaths(graph: ThreadGraph, expanded: ReadonlySet<string>, collapsed: ReadonlySet<string>) {
    const result = new Set(expanded);
    for (const key of expanded) {
        let node = graph.nodes.get(key);
        const visited = new Set<string>();
        while (node?.parent && visited.size < graph.limits.maxDepth && !visited.has(node.parent)) {
            visited.add(node.parent);
            if (collapsed.has(node.parent)) break;
            result.add(node.parent);
            node = graph.nodes.get(node.parent);
        }
    }
    return result;
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
export function discussionCoverage(snapshot: DiscussionSnapshot) {
    const failed = snapshot.coverage.filter(work => work.outcome && !["eose", "found"].includes(work.outcome) && !work.satisfied).length;
    const pending = snapshot.coverage.filter(work => !work.exhausted && !work.truncated && !work.satisfied).length;
    const routingFailed = snapshot.routing.some(route => Object.values(route.relays).some(outcome => outcome !== "eose"));
    const limited = snapshot.retentionLimited || snapshot.limitations.length > 0;
    return { failed, pending, limited, partial: failed > 0 || routingFailed || limited || pending > 0 || snapshot.state === "paused" };
}
