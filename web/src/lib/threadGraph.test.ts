import { describe, expect, it } from "vitest";
import { createThreadGraph, projectThread, reduceThreadGraph, type ThreadEvent, type ThreadGraph } from "./threadGraph";
import { relationKey } from "./threadRelations";

// Synthetic metadata isolates relation semantics. Network ingress verifies signed
// events separately in verifyNostrEvent/nostrTransport regression tests.
const id = (n: number) => n.toString(16).padStart(64, "0");
const author = id(9000), other = id(9001);
const key = (n: number) => `event:${id(n)}`;
const event = (n: number, tags: string[][] = [], kind = 1, created_at = n): ThreadEvent => ({ id: id(n), pubkey: author, kind, created_at, tags });
const reply = (n: number, parent: number, root?: number, created_at = n) => event(n,
    [...(root === undefined ? [] : [["e", id(root), "", "root"]]), ["e", id(parent), "", "reply"]], 1, created_at);
const address = `30023:${author}:article`;
const article = (n: number, created_at = n) => event(n, [["d", "article"]], 30023, created_at);
const comment = (n: number, parent: number, parentKind = 1111, extra: string[][] = []) => event(n,
    [["A", address], ["K", "30023"], ["P", author], ["e", id(parent)], ["k", String(parentKind)], ["p", author], ...extra], 1111);
function assemble(events: ThreadEvent[], graph = createThreadGraph()): ThreadGraph {
    for (let i = 0; i < events.length; i += graph.limits.maxBatch) graph = reduceThreadGraph(graph, events.slice(i, i + graph.limits.maxBatch));
    return graph;
}
const snapshot = (graph: ThreadGraph) => ({ nodes: [...graph.nodes], children: [...graph.children], aliases: [...graph.aliases], limited: graph.limited, bytes: graph.bytes });
function shuffled<T>(input: T[], seed: number): T[] {
    const output = [...input];
    for (let i = output.length - 1; i > 0; i--) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const j = seed % (i + 1);
        [output[i], output[j]] = [output[j], output[i]];
    }
    return output;
}

describe("reply graph and Holoboard focus", () => {
    it("follows parents, rather than connecting every root or quote reference", () => {
        const graph = assemble([event(1), reply(2, 1, 1), reply(3, 2, 1), event(4, [["q", id(1)]]),
            reply(5, 4, 4), event(6, [["e", id(1), "", "mention"]])]);
        expect(projectThread(graph, id(1)).replies.map((row) => row.key)).toEqual([key(2), key(3)]);
        expect(projectThread(graph, id(4)).replies.map((row) => row.key)).toEqual([key(5)]);
        expect(graph.nodes.get(key(6))?.parentState).toBe("none");
    });
    it("opens a promoted middle reply without making it the protocol root or dropping unpaid intermediates", () => {
        const graph = assemble([event(1), reply(2, 1, 1), reply(3, 2, 1), reply(4, 3, 1), reply(5, 1, 1)]);
        const view = projectThread(graph, id(2));
        expect(view.ancestors.map((row) => row.key)).toEqual([key(1)]);
        expect(view.replies.map((row) => row.key)).toEqual([key(3), key(4)]);
        expect(graph.nodes.get(key(2))).toMatchObject({ parent: key(1), rootState: "matched" });
        expect(projectThread(graph, id(1)).loadedReplyCount).toBe(4);
    });
    it("preserves missing parents and resolves them without duplicating exact-ID nodes", () => {
        const first = assemble([reply(3, 2, 1)]);
        expect(first.nodes.get(key(3))).toMatchObject({ parent: key(2), parentState: "missing", rootState: "unresolved" });
        expect(projectThread(first, id(3))).toMatchObject({ ancestorStop: "missing", ancestors: [{ key: key(2), visibility: "missing" }] });
        expect(projectThread(first, id(1)).replies).toEqual([]);
        const next = reduceThreadGraph(first, [event(1), reply(2, 1, 1)]);
        expect(next.nodes.size).toBe(3);
        expect(next.nodes.get(key(3))).toMatchObject({ parentState: "resolved", rootState: "matched" });
        expect(projectThread(next, id(3)).ancestors.map((row) => row.key)).toEqual([key(1), key(2)]);
        expect(first.nodes.get(key(2))?.event).toBeUndefined();
    });
    it("orders ancestor paths by edges even with clock skew", () => {
        const graph = assemble([event(1, [], 1, 300), reply(2, 1, 1, 200), reply(3, 2, 1, 100)]);
        expect(projectThread(graph, id(3)).ancestors.map((row) => row.key)).toEqual([key(1), key(2)]);
    });
    it("keeps sibling sorting separate from topology with an explicit ID tie-break", () => {
        const graph = assemble([event(1), reply(2, 1, 1, 400), reply(3, 1, 1, 200), reply(4, 1, 1, 200)]);
        const before = snapshot(graph);
        const view = projectThread(graph, id(1), { compareSiblings: (a, b) => a.event!.created_at - b.event!.created_at });
        expect(view.replies.map((row) => row.key)).toEqual([key(3), key(4), key(2)]);
        expect(snapshot(graph)).toEqual(before);
    });
    it("preserves hidden and deleted parent positions and their loaded descendants", () => {
        const graph = assemble([event(1), reply(2, 1, 1), reply(3, 2, 1), reply(4, 3, 1)]);
        const view = projectThread(graph, id(1), { hiddenIds: new Set([id(2)]), deletedIds: new Set([id(3)]) });
        expect(view.replies).toEqual([
            { key: key(2), depth: 1, visibility: "hidden" }, { key: key(3), depth: 2, visibility: "deleted" },
            { key: key(4), depth: 3, visibility: "visible" },
        ]);
        expect(view.loadedReplyCount).toBe(3);
        expect(graph.nodes.get(key(4))?.parent).toBe(key(3));
    });
    it("diagnoses a contradictory root without joining that root's conversation", () => {
        const graph = assemble([event(1), event(7), reply(2, 1, 7)]);
        expect(graph.nodes.get(key(2))).toMatchObject({ parent: key(1), rootState: "conflict", issues: ["root:ancestry-conflict"] });
        expect(projectThread(graph, id(7)).replies).toEqual([]);
    });
    it("never guesses among competing parents", () => {
        const graph = assemble([event(1), event(2), event(3, [["e", id(1), "", "reply"], ["e", id(2), "", "reply"]])]);
        expect(graph.nodes.get(key(3))?.parentState).toBe("conflict");
        expect(graph.nodes.get(key(3))?.parent).toBeUndefined();
        expect(graph.children.size).toBe(0);
    });
    it("reports contradictory root declarations even while the ultimate ancestor is missing", () => {
        const graph = assemble([reply(2, 1, 1), reply(3, 2, 7)]);
        expect(graph.nodes.get(key(3))).toMatchObject({ parent: key(2), rootState: "conflict", issues: ["root:declared-scope-conflict"] });
        expect(projectThread(graph, id(7)).replies).toEqual([]);
    });
    it("checks kind and author hints when a missing parent arrives", () => {
        const first = assemble([event(2, [["e", id(1), "", "reply", other]])]);
        expect(first.nodes.get(key(2))?.parentState).toBe("missing");
        const graph = reduceThreadGraph(first, [event(1)]);
        expect(graph.nodes.get(key(2))).toMatchObject({ parentState: "conflict", issues: ["parent:author-conflict"] });
        expect(graph.children.size).toBe(0);
        const wrongKind = assemble([event(1, [], 7), reply(2, 1)]);
        expect(wrongKind.nodes.get(key(2))?.issues).toContain("parent:kind-conflict");
    });
    it.each([6, 7, 9735])("keeps a NIP-22 comment on kind %s inside that event's scope", (kind) => {
        const graph = assemble([event(1), event(2, [["e", id(1)]], kind), event(3,
            [["E", id(2)], ["K", String(kind)], ["P", author], ["e", id(2)], ["k", String(kind)], ["p", author]], 1111)]);
        expect(projectThread(graph, id(1)).replies).toEqual([]);
        expect(projectThread(graph, id(2)).replies.map((row) => row.key)).toEqual([key(3)]);
        expect(graph.nodes.get(key(3))?.rootState).toBe("matched");
    });
});

describe("address and external identities", () => {
    it("uses the newest address version with a lowest-ID tie-break regardless of arrival", () => {
        const top = event(5, [["A", address], ["K", "30023"], ["P", author], ["a", address], ["k", "30023"], ["p", author]], 1111);
        for (const versions of [[article(2, 10), article(1, 10)], [article(1, 10), article(2, 10)]]) {
            const graph = assemble([...versions, top]);
            expect(graph.aliases.get(address)).toBe(id(1));
            expect(graph.nodes.get(key(5))).toMatchObject({ parent: key(1), rootState: "matched" });
            expect(graph.events.size).toBe(3);
        }
        const updated = assemble([article(1, 10), article(2, 20), top]);
        expect(updated.nodes.get(key(5))?.parent).toBe(key(2));
    });
    it("pins an address-plus-ID parent to its exact version, including while missing", () => {
        const child = comment(5, 1, 30023, [["a", address]]);
        const first = assemble([article(2, 20), child]);
        expect(first.nodes.get(key(5))).toMatchObject({ parent: key(1), parentState: "missing" });
        expect(projectThread(first, id(2)).replies).toEqual([]);
        const next = reduceThreadGraph(first, [article(1, 10)]);
        expect(next.aliases.get(address)).toBe(id(2));
        expect(next.nodes.get(key(5))).toMatchObject({ parent: key(1), parentState: "resolved", rootState: "matched" });
    });
    it("retains exact root-version constraints independently from the latest address alias", () => {
        const child = comment(5, 2, 30023, [["E", id(1)]]);
        const graph = assemble([article(1, 10), article(2, 20), child]);
        expect(graph.nodes.get(key(5))).toMatchObject({ parent: key(2), rootState: "conflict" });
    });
    it("rejects an exact-version alias pointing to a different signed address", () => {
        const graph = assemble([event(1, [["d", "different"]], 30023), comment(5, 1, 30023, [["a", address]])]);
        expect(graph.nodes.get(key(5))).toMatchObject({ parentState: "conflict", issues: ["parent:address-conflict"] });
        expect(graph.nodes.get(key(5))?.parent).toBeUndefined();
    });
    it("resolves address placeholders without retaining a duplicate placeholder node", () => {
        const child = event(5, [["A", address], ["K", "30023"], ["P", author], ["a", address], ["k", "30023"], ["p", author]], 1111);
        const first = assemble([child]);
        expect(first.nodes.has(`address:${address}`)).toBe(true);
        const graph = reduceThreadGraph(first, [article(1)]);
        expect(graph.nodes.size).toBe(2);
        expect(graph.nodes.has(`address:${address}`)).toBe(false);
        expect(graph.children.get(key(1))).toEqual([key(5)]);
    });
    it("resolves ambiguous lowercase p tags against the loaded parent", () => {
        const graph = assemble([article(1), comment(2, 1, 30023, [["p", other]])]);
        expect(graph.nodes.get(key(2))?.parentState).toBe("resolved");
        const wrong = assemble([{ ...article(1), pubkey: id(9100) }, comment(2, 1, 30023, [["p", other]])]);
        expect(wrong.nodes.get(key(2))?.issues).toContain("parent:author-conflict");
    });
    it("retains opaque external scopes without scheduling a lookup or synthesizing a URL", () => {
        const scope = "podcast:item:guid:episode-1";
        const graph = assemble([event(1, [["I", scope], ["K", "podcast:item:guid"], ["i", scope], ["k", "podcast:item:guid"]], 1111)]);
        const externalKey = relationKey({ type: "external", value: scope, kind: "podcast:item:guid", relays: [], hints: [] });
        expect(graph.nodes.get(key(1))).toMatchObject({ parent: externalKey, parentState: "external", rootState: "matched" });
        expect(projectThread(graph, id(1)).ancestorStop).toBe("external");
    });
    it("does not equate external scopes with different declared kinds", () => {
        const graph = assemble([event(1, [["I", "opaque:value"], ["K", "one"], ["i", "opaque:value"], ["k", "two"]], 1111)]);
        expect(graph.nodes.get(key(1))?.rootState).toBe("conflict");
    });
});

describe("determinism, immutability and budgets", () => {
    it("produces identical graphs for shuffled events and incremental batches", () => {
        const data = [event(1), reply(2, 1, 1), reply(3, 2, 1), reply(4, 1, 1),
            article(10, 20), article(11, 10), comment(12, 11, 30023, [["a", address]]), comment(13, 12),
            reply(20, 19, 1), event(21, [["q", id(1)]]), reply(22, 21, 21)];
        const expected = snapshot(assemble(data));
        for (let seed = 1; seed <= 40; seed++) {
            const permutation = shuffled(data, seed);
            expect(snapshot(assemble(permutation))).toEqual(expected);
            let graph = createThreadGraph();
            for (let i = 0; i < permutation.length; i += 3) graph = reduceThreadGraph(graph, permutation.slice(i, i + 3));
            expect(snapshot(graph)).toEqual(expected);
        }
    });
    it("copies admitted metadata and preserves the previous reducer state", () => {
        const input = reply(2, 1);
        const first = assemble([input]);
        input.tags[0][1] = id(99);
        expect(first.events.get(id(2))?.tags[0][1]).toBe(id(1));
        const previous = snapshot(first);
        const second = reduceThreadGraph(first, [event(1), event(1)]);
        expect(snapshot(first)).toEqual(previous);
        expect(second.events.size).toBe(2);
    });
    it("rejects all cyclic parent edges deterministically and preserves outside descendants", () => {
        const data = [reply(1, 2), reply(2, 1), reply(3, 2), reply(4, 4)];
        for (const order of [data, [...data].reverse()]) {
            const graph = assemble(order);
            for (const n of [1, 2, 4]) {
                expect(graph.nodes.get(key(n))).toMatchObject({ parentState: "cycle" });
                expect(graph.nodes.get(key(n))?.parent).toBeUndefined();
            }
            expect(graph.nodes.get(key(3))?.parent).toBe(key(2));
            expect(projectThread(graph, id(3)).ancestorStop).toBe("cycle");
        }
    });
    it("bounds projection depth without deleting valid graph edges or using recursion", () => {
        const data = [event(1), ...Array.from({ length: 399 }, (_, n) => reply(n + 2, n + 1, 1))];
        const graph = assemble(data);
        expect(graph.nodes.get(key(400))).toMatchObject({ parent: key(399), rootState: "depth-limit" });
        const descendantView = projectThread(graph, id(1));
        expect(descendantView.replies.length).toBe(graph.limits.maxDepth);
        expect(descendantView.truncated).toBe(true);
        expect(projectThread(graph, id(400))).toMatchObject({ ancestorStop: "depth-limit", truncated: true });
    });
    it("retains an ID-sorted prefix under event pressure, independent of bounded batch order", () => {
        const data = Array.from({ length: 20 }, (_, n) => event(n + 1));
        const expected = [id(1), id(2), id(3)];
        for (const order of [data, [...data].reverse(), shuffled(data, 12)]) {
            let graph = createThreadGraph({ maxEvents: 3 });
            for (const input of order) graph = reduceThreadGraph(graph, [input]);
            expect([...graph.events.keys()]).toEqual(expected);
            expect(graph.limited).toBe(true);
        }
    });
    it("reports byte, per-event and batch losses rather than claiming completeness", () => {
        const size = JSON.stringify(event(1)).length * 3;
        const bytes = assemble([event(1), event(2)], createThreadGraph({ maxBytes: size }));
        expect(bytes.events.size).toBe(1); expect(bytes.bytes).toBeLessThanOrEqual(size); expect(bytes.limited).toBe(true);
        const oversized = assemble([reply(1, 2)], createThreadGraph({ maxEventBytes: 10 }));
        expect(oversized.events.size).toBe(0); expect(oversized.limited).toBe(true);
        const batch = reduceThreadGraph(createThreadGraph({ maxBatch: 1 }), [event(1), event(2)]);
        expect(batch.events.size).toBe(1); expect(batch.limited).toBe(true);
        expect(projectThread(batch, id(1)).truncated).toBe(true);
    });
    it("bounds placeholder admission while retaining the unresolved claim", () => {
        const graph = assemble([reply(3, 2, 1)], createThreadGraph({ maxNodes: 1 }));
        expect(graph.nodes.size).toBe(1);
        expect(graph.nodes.get(key(3))).toMatchObject({ parentState: "budget", rootState: "budget" });
        expect(graph.nodes.get(key(3))?.relations?.parent.target?.value).toBe(id(2));
        expect(graph.limited).toBe(true);
    });
    it("does not allow a view to raise the shared model's hard resource ceilings", () => {
        expect(() => createThreadGraph({ maxEvents: 2049 })).toThrow(RangeError);
        expect(() => createThreadGraph({ maxDepth: 0 })).toThrow(RangeError);
        expect(() => createThreadGraph({ maxDepth: NaN })).toThrow(RangeError);
    });
});
