import { describe, it, expect } from "vitest";
import { boardReturnPath, discussionRoute, discussionHref, discussionProjection, expandedReplies, expansionPaths, discussionCoverage } from "./discussionView";
import { createThreadGraph, reduceThreadGraph, type ThreadEvent } from "./threadGraph";
import type { DiscussionSnapshot } from "./discussionReads";
const id = (n: number) => n.toString(16).padStart(64, "0");
const key = (n: number) => `event:${id(n)}`;
const event = (n: number, parent?: number, root = 1, time = n): ThreadEvent => ({ id: id(n), pubkey: id(999), kind: 1, created_at: time,
    tags: parent ? [["e", id(root), "", "root"], ["e", id(parent), "", "reply"]] : [] });
const graph = (...events: ThreadEvent[]) => reduceThreadGraph(createThreadGraph(), events);
describe("discussion presentation contracts", () => {
    it("accepts exact shareable IDs and restricts board return paths", () => {
        expect(discussionRoute(discussionHref(id(2), id(999), "/waiting?view=hot"))).toEqual({ focusId: id(2), author: id(999), from: "/waiting?view=hot" });
        for (const path of ["https://evil.example", "//evil.example", "/help", "/waiting/../other", "/?redirect=unsafe"]) expect(boardReturnPath(path)).toBe("/");
        expect(discussionRoute(`/discussion/${id(2)}?author=bad&from=https://evil.example`)?.author).toBeUndefined();
        expect(discussionRoute("/discussion/not-an-id")).toBeNull();
    });
    it("keeps clock-skewed ancestor paths and chronological sibling order separate", () => {
        const view = discussionProjection(graph(event(1, undefined, 1, 500), event(2, 1, 1, 400), event(3, 2, 1, 300), event(4, 2, 1, 200), event(5, 4, 1, 100)), id(2));
        expect(view.ancestors.map(row => row.key)).toEqual([key(1)]);
        expect(view.replies.map(row => row.key)).toEqual([key(4), key(5), key(3)]);
    });
    it("keeps orphan branches separate and preserves expansion when a parent arrives", () => {
        const first = graph(event(1), event(3, 2), event(4, 3));
        const before = discussionProjection(first, id(1));
        expect(before.replies).toEqual([]);
        expect(before.unresolved.map(row => row.key)).toEqual([key(3), key(4)]);
        const after = discussionProjection(reduceThreadGraph(first, [event(2, 1)]), id(1));
        expect(after.unresolved).toEqual([]);
        const final = reduceThreadGraph(first, [event(2, 1)]);
        expect(expandedReplies(after.replies, expansionPaths(final, new Set([key(3)]), new Set())).map(row => row.key)).toEqual([key(2), key(3), key(4)]);
        expect(expandedReplies(after.replies, expansionPaths(final, new Set([key(3)]), new Set([key(2)]))).map(row => row.key)).toEqual([key(2)]);
        expect(expandedReplies(after.replies, new Set([key(2), key(3)])).map(row => row.key)).toEqual([key(2), key(3), key(4)]);
        expect(expandedReplies(after.replies, new Set([key(3)])).map(row => row.key)).toEqual([key(2)]);
    });
    it("never includes replies to a promotional quote or unrelated root scope", () => {
        const view = discussionProjection(graph(event(1), event(2, 1), event(10), event(11, 10, 10), event(12, 13, 10)), id(1));
        expect(view.replies.map(row => row.key)).toEqual([key(2)]);
        expect(view.unresolved).toEqual([]);
    });
    it("resolves address root aliases without losing exact-version pins", () => {
        const article: ThreadEvent = { ...event(1), kind: 30023, tags: [["d", "article"]] };
        const address = `30023:${article.pubkey}:article`;
        const comment: ThreadEvent = { ...event(3), kind: 1111, tags: [["A", address], ["K", "30023"], ["P", article.pubkey], ["e", id(2)], ["k", "1111"], ["p", article.pubkey]] };
        expect(discussionProjection(graph(article, comment), id(1)).unresolved.map(row => row.key)).toEqual([key(3)]);
    });
    it("does not treat an opaque external scope as a Nostr address", () => {
        const article: ThreadEvent = { ...event(1), kind: 30023, tags: [["d", "article"]] };
        const address = `30023:${article.pubkey}:article`;
        const comment: ThreadEvent = { ...event(3), kind: 1111,
            tags: [["I", address], ["K", "unknown"], ["i", "external-parent"], ["k", "unknown"]] };
        expect(discussionProjection(graph(article, comment), id(1)).unresolved).toEqual([]);
    });
    it("reports query failures, unfinished discovery and local retention separately", () => {
        const snapshot = { coverage: [], routing: [], retentionLimited: false, limitations: [], state: "settled" } as unknown as DiscussionSnapshot;
        expect(discussionCoverage(snapshot).partial).toBe(false);
        expect(discussionCoverage({ ...snapshot, retentionLimited: true })).toMatchObject({ partial: true, limited: true, failed: 0 });
        expect(discussionCoverage({ ...snapshot, coverage: [{ outcome: "timeout", satisfied: false, exhausted: false }] as DiscussionSnapshot["coverage"] })).toMatchObject({ partial: true, failed: 1, pending: 1 });
        expect(discussionCoverage({ ...snapshot, routing: [{ author: id(999), read: [], write: [], fromCache: false, relays: { source: "timeout" } }] as DiscussionSnapshot["routing"] }).partial).toBe(true);
    });
});
