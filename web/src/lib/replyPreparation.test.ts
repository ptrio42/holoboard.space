import { expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, type Event } from "nostr-tools";
import { createThreadGraph, reduceThreadGraph } from "./threadGraph";
import { normalizeThreadRelations } from "./threadRelations";
import { prepareReply } from "./replyPreparation";
const key = generateSecretKey(), other = generateSecretKey();
const make = (kind = 1, tags: string[][] = [], content = "context", created_at = 1700000000, secret = key) => finalizeEvent({ kind, tags, content, created_at }, secret);
const graphOf = (...events: Event[]) => reduceThreadGraph(createThreadGraph(), events);
const prepare = (parent: Event, events: Event[] = [parent]) => prepareReply({ parent, graph: graphOf(...events), content: "A new reply", createdAt: 1700000100 });
it("preserves reply ancestry while adding only the current attachment metadata", () => {
    const parent = make(1, [["imeta", "url https://old.example.com/parent.png", "alt Parent file"]]);
    const attachment = { url: "https://media.example.com/reply.png", type: "image/png", alt: "Reply file" };
    const prepared = prepareReply({ parent, graph: graphOf(parent), content: attachment.url, attachments: [attachment], createdAt: 1700000100 });
    expect(prepared.template.tags).toContainEqual(["imeta", `url ${attachment.url}`, "m image/png", "alt Reply file"]);
    expect(JSON.stringify(prepared.template.tags)).not.toContain("Parent file");
    const signed = finalizeEvent(prepared.template, other);
    expect(graphOf(parent, signed).nodes.get(`event:${signed.id}`)?.parent).toBe(`event:${parent.id}`);
});
function roundtrip(parent: Event, events: Event[]) {
    const prepared = prepare(parent, events);
    const signed = finalizeEvent(prepared.template, other);
    const graph = graphOf(...events, signed);
    expect(graph.nodes.get(`event:${signed.id}`)).toMatchObject({ parent: `event:${parent.id}`, parentState: "resolved", rootState: "matched" });
    return { prepared, signed, graph };
}
it("replies to the original item and to a promoted middle note without following a promotional quote", () => {
    const root = make();
    const unpaid = make(1, [["e", root.id, "", "root", root.pubkey]], "unpaid", 1699999990);
    const promotedMiddle = make(1, [["e", root.id, "", "root", root.pubkey], ["e", unpaid.id, "", "reply", unpaid.pubkey]], "middle");
    const quote = make(1, [["q", promotedMiddle.id, "", promotedMiddle.pubkey]], "promotional quote", 1700000010, other);
    for (const events of [[root, unpaid, promotedMiddle, quote], [quote, promotedMiddle, unpaid, root]]) {
        const { prepared } = roundtrip(promotedMiddle, events);
        expect(prepared.template.tags.filter(tag => tag[0] === "e").map(tag => [tag[1], tag[3]])).toEqual([[root.id, "root"], [promotedMiddle.id, "reply"]]);
        expect(JSON.stringify(prepared)).not.toContain(quote.id);
    }
    expect(roundtrip(root, [root]).prepared.template.tags.filter(tag => tag[0] === "e")).toHaveLength(1);
});
it("waits for missing legacy ancestors instead of guessing the selected parent is the root", () => {
    const root = make(), legacy = make(1, [["e", root.id]]);
    expect(() => prepare(legacy)).toThrow("incomplete");
    expect(roundtrip(legacy, [root, legacy]).prepared.root.value).toBe(root.id);
    const conflict = make(1, [["e", root.id, "", "root"], ["e", "a".repeat(64), "", "root"]]);
    expect(() => prepare(conflict, [root, conflict])).toThrow("conflicting");
});
it("keeps explicit root hints and blocks a truncated ancestry path", () => {
    const root = make(), parent = make(1, [["e", root.id, "wss://root.example.com", "root", root.pubkey]]);
    expect(prepare(parent, [root, parent]).template.tags[0][2]).toBe("wss://root.example.com");
    const graph = reduceThreadGraph(createThreadGraph({ maxDepth: 1 }), [root, parent]);
    expect(() => prepareReply({ parent, graph, content: "reply", createdAt: 100 })).toThrow("incomplete");
});
it("retains address scope and pinned version while replying to a kind-1111 middle comment", () => {
    const article = make(30023, [["d", "post:one"]]);
    const address = `30023:${article.pubkey}:post:one`;
    const newer = make(30023, [["d", "post:one"]], "edited article", 1700000050);
    const comment = make(1111, [["A", address], ["E", article.id, "", article.pubkey], ["K", "30023"], ["P", article.pubkey], ["a", address], ["e", article.id, "", article.pubkey], ["k", "30023"], ["p", article.pubkey]]);
    const { prepared } = roundtrip(comment, [article, newer, comment]);
    expect(prepared.template.kind).toBe(1111);
    expect(normalizeThreadRelations(prepared.template)).toMatchObject({ root: { state: "valid", target: { type: "address", value: address, exactId: article.id } }, parent: { target: { value: comment.id, kind: 1111 } } });
    expect(JSON.stringify(prepared.template)).not.toContain(newer.id);
});
it("prepares top-level article comments with stable scopes and exact parent IDs", () => {
    const article = make(30023, [["d", "post"]]);
    const { prepared } = roundtrip(article, [article]);
    expect(prepared.template.tags.map(tag => tag[0])).toEqual(["A", "E", "K", "P", "a", "e", "k", "p"]);
    expect(normalizeThreadRelations(prepared.template).parent.target).toMatchObject({ type: "address", exactId: article.id });
});
it("preserves an opaque external root through a NIP-22 comment without fetching or rewriting it", () => {
    const scope = "podcast:item:guid:episode";
    const comment = make(1111, [["I", scope, "javascript:untrusted"], ["K", "podcast:item:guid"], ["i", scope], ["k", "podcast:item:guid"]]);
    const { prepared } = roundtrip(comment, [comment]);
    expect(prepared.template.tags[0]).toEqual(["I", scope]);
    expect(prepared.root).toMatchObject({ type: "external", value: scope, kind: "podcast:item:guid" });
    expect(normalizeThreadRelations(prepared.template).parent.target).toMatchObject({ type: "event", value: comment.id });
});
it("rejects forged parent objects, missing bodies, invalid context, oversized text and excessive inherited recipients", () => {
    const parent = make(), graph = graphOf(parent);
    const forged = { ...parent, sig: "0".repeat(128) };
    expect(() => prepareReply({ parent: forged, graph, content: "reply", createdAt: 100 })).toThrow("verified");
    expect(() => prepareReply({ parent, graph: createThreadGraph(), content: "reply", createdAt: 100 })).toThrow("incomplete");
    for (const content of [" ", "💡".repeat(4097)]) expect(() => prepareReply({ parent, graph, content, createdAt: 100 })).toThrow("16 KiB");
    expect(() => prepareReply({ parent, graph, content: "reply", createdAt: NaN })).toThrow("timestamp");
    const crowded = make(1, Array.from({ length: 65 }, (_, i) => ["p", i.toString(16).padStart(64, "0")]));
    expect(() => prepare(crowded)).toThrow("64-recipient");
});
it("uses only safe reference hints and retains inherited participants without copying arbitrary tags", () => {
    const parent = make(1, [["p", "b".repeat(64), "ws://127.0.0.1:9000"], ["amount", "9999999"], ["q", "f".repeat(64)]]);
    const prepared = prepareReply({ parent, graph: graphOf(parent), content: "exact text\n", createdAt: 100, hints: { [parent.id]: ["ws://127.0.0.1:9000", "wss://relay.example.com"] } });
    expect(prepared.template.tags[0][2]).toBe("wss://relay.example.com");
    expect(prepared.template.content).toBe("exact text\n");
    expect(prepared.recipients).toContain("b".repeat(64));
    expect(prepared.template.tags.some(tag => ["amount", "q"].includes(tag[0]))).toBe(false);
});
