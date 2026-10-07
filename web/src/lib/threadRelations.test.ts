import { describe, expect, it } from "vitest";
import { parse as parseNip10 } from "nostr-tools/nip10";
import { normalizeThreadRelations as normalize, parseThreadAddress } from "./threadRelations";

const root = "a".repeat(64), parent = "b".repeat(64), author = "c".repeat(64), other = "d".repeat(64);
const note = (tags: string[][]) => ({ kind: 1, tags });
const comment = (tags: string[][]) => ({ kind: 1111, tags });
const scope = [["A", `30023:${author}:part:one`], ["K", "30023"], ["P", author]];
const reply = [["e", parent, "wss://parent.example", other], ["k", "1111"], ["p", other]];

describe("NIP-10 claims", () => {
    it("separates marked root and parent in either order, retaining discovery hints", () => {
        const tags = [["e", root, "", "root"], ["e", parent, "wss://parent.example", "reply", author], ["q", other]];
        const parsed = normalize(note(tags));
        expect(parsed.root.target?.value).toBe(root);
        expect(parsed.parent.target).toMatchObject({ value: parent, author, relays: ["wss://parent.example"], kind: 1 });
        expect(normalize(note([...tags].reverse()))).toEqual(parsed);
    });
    it("uses a marked root as the direct parent for a top-level reply", () => {
        const parsed = normalize(note([["e", root, "", "root"]]));
        expect(parsed.parent).toEqual(parsed.root);
    });
    it("does not invent a root for a reply-only or sole positional reference", () => {
        for (const tags of [[["e", parent, "", "reply"]], [["e", parent]]]) {
            const parsed = normalize(note(tags));
            expect(parsed.root.state).toBe("absent");
            expect(parsed.parent.target?.value).toBe(parent);
        }
    });
    it("respects the order of deprecated positional tags", () => {
        const parsed = normalize(note([["e", root], ["e", other], ["e", parent]]));
        expect(parsed.provenance).toBe("positional");
        expect(parsed.root.target?.value).toBe(root);
        expect(parsed.parent.target?.value).toBe(parent);
        expect(normalize(note([["e", parent], ["e", root]])).parent.target?.value).toBe(root);
    });
    it("ignores quotes, mentions and unmarked candidates when marked semantics are present", () => {
        expect(normalize(note([["q", root], ["e", parent, "", "mention"]])).parent.state).toBe("absent");
        const parsed = normalize(note([["e", root, "", "root"], ["e", parent]]));
        expect(parsed.parent.target?.value).toBe(root);
        expect(normalize(note([["e", root, "", "unknown"], ["e", parent]])).parent.state).toBe("absent");
    });
    it("merges repeated equivalent references and reports contradictory parent claims", () => {
        const repeated = normalize(note([["e", parent, "wss://b.example", "reply"], ["e", parent, "wss://a.example", "reply", author]]));
        expect(repeated.parent.state).toBe("valid");
        expect(repeated.parent.target?.relays).toEqual(["wss://a.example", "wss://b.example"]);
        const tags = [["e", root, "", "reply"], ["e", parent, "", "reply"]];
        expect(normalize(note(tags)).parent).toMatchObject({ state: "conflict", issues: ["multiple-targets"] });
        expect(normalize(note([...tags].reverse()))).toEqual(normalize(note(tags)));
    });
    it("keeps contradictory author hints deterministic", () => {
        const tags = [["e", parent, "", "reply", author], ["e", parent, "", "reply", other]];
        expect(normalize(note(tags)).parent.state).toBe("conflict");
        expect(normalize(note([...tags].reverse()))).toEqual(normalize(note(tags)));
    });
    it("does not silently replace a malformed marked target with an unmarked one", () => {
        expect(normalize(note([["e", "broken", "", "reply"], ["e", parent]])).parent.state).toBe("invalid");
        expect(normalize(note([["e", parent, "", "reply", "broken"]])).parent.issues).toContain("invalid-author");
    });
    it("does not thread reactions, zaps, reposts or addressable content through their e tags", () => {
        for (const kind of [5, 6, 7, 9735, 30023]) {
            expect(normalize({ kind, tags: [["e", parent]] }).protocol).toBe("none");
        }
    });
});

describe("NIP-22 claims", () => {
    it("retains an address and its exact version in either tag order", () => {
        const tags = [...scope, ["a", `30023:${author}:part:one`, "wss://address.example"],
            ["e", parent, "wss://exact.example", author], ["k", "30023"], ["p", author]];
        const parsed = normalize(comment(tags));
        expect(parsed.parent).toMatchObject({ state: "valid", target: { type: "address", exactId: parent, author, kind: 30023 } });
        expect(parsed.parent.target?.relays).toEqual(["wss://address.example", "wss://exact.example"]);
        expect(normalize(comment([...tags].reverse()))).toEqual(parsed);
    });
    it("keeps uppercase scope independent from the direct parent", () => {
        const parsed = normalize(comment([...scope, ...reply]));
        expect(parsed.root.target).toMatchObject({ type: "address", value: `30023:${author}:part:one` });
        expect(parsed.parent.target).toMatchObject({ type: "event", value: parent, author: other, kind: 1111 });
    });
    it.each([
        { tags: [...scope, ["e", parent], ["p", other]], issue: "missing-kind", state: "invalid" },
        { tags: [...scope, ...reply, ["k", "7"]], issue: "kind-conflict", state: "conflict" },
        { tags: [...scope, ["a", `30023:${author}:part:one`], ["k", "1"], ["p", author]], issue: "kind-conflict", state: "conflict" },
        { tags: [...scope, ["e", parent], ["k", "1111suffix"], ["p", other]], issue: "invalid-kind", state: "invalid" },
        { tags: [...scope, ["e", parent], ["k", "65536"], ["p", other]], issue: "invalid-kind", state: "invalid" },
        { tags: [...scope, ["e", parent, "", author], ["k", "1111"], ["p", other]], issue: "author-conflict", state: "conflict" },
        { tags: [...scope, ["e", parent], ["k", "1111"]], issue: "missing-author", state: "invalid" },
        { tags: [...scope, ["e", "invalid"], ["k", "1111"], ["p", other]], issue: "invalid-reference", state: "invalid" },
        { tags: [...scope, ...reply, ["e", root]], issue: "multiple-targets", state: "conflict" },
    ])("exposes $issue instead of choosing a target", ({ tags, issue, state }) => {
        const parsed = normalize(comment(tags));
        expect(parsed.parent.state).toBe(state);
        expect(parsed.parent.issues).toContain(issue);
        expect(parsed.parent.target).toBeUndefined();
    });
    it("requires root reference, kind and author independently", () => {
        expect(normalize(comment(reply)).root.issues).toEqual(["missing-author", "missing-kind", "missing-reference"]);
        expect(normalize(comment([...scope, ...reply, ["P", other]])).root.state).toBe("conflict");
    });
    it("treats additional lowercase p tags as possible mentions, not competing parents", () => {
        expect(normalize(comment([...scope, ...reply, ["p", author]])).parent).toMatchObject({ state: "valid", target: { author: other } });
        const parsed = normalize(comment([...scope, ["e", parent], ["k", "1111"], ["p", other], ["p", author]]));
        expect(parsed.parent).toMatchObject({ state: "valid", authors: [author, other] });
        expect(parsed.parent.target?.author).toBeUndefined();
    });
    it.each(["https://example.com/article", "podcast:item:guid:episode-1", "geo:u4pruy", "#nostr", "unknown:opaque"]) (
        "retains external scope %s without turning it into a navigation URL", (value) => {
            const parsed = normalize(comment([["I", value, "https://example.com/hint"], ["K", "unknown"], ["i", value], ["k", "unknown"]]));
            expect(parsed.root).toMatchObject({ state: "valid", target: { type: "external", value, kind: "unknown", hints: ["https://example.com/hint"], relays: [] } });
        });
    it("does not choose an external scope over a conflicting Nostr scope", () => {
        expect(normalize(comment([...scope, ["I", "https://example.com"], ...reply])).root.state).toBe("conflict");
    });
    it("accepts empty and colon-containing address identifiers, while rejecting non-addressable kinds", () => {
        expect(parseThreadAddress(`30023:${author}:`)).toMatchObject({ kind: 30023, identifier: "" });
        expect(parseThreadAddress(`30023:${author}:part:one`)).toMatchObject({ identifier: "part:one" });
        expect(parseThreadAddress(`10002:${author}:`)).toBeDefined();
        expect(parseThreadAddress(`1111:${author}:`)).toBeUndefined();
        expect(parseThreadAddress(`10002:${author}:unexpected`)).toBeUndefined();
    });
});

describe("installed nostr-tools 2.25.2 parser behavior", () => {
    it("distinguishes its root fallback from an explicit protocol root claim", () => {
        const event = { ...note([["e", parent]]), id: root, pubkey: author, created_at: 1, content: "", sig: "0".repeat(128) };
        expect(parseNip10(event).root?.id).toBe(parent);
        expect(normalize(event).root.state).toBe("absent");
    });
    it("does not rely on the library's tag-order choice for conflicting marked parents", () => {
        const tags = [["e", root, "", "reply"], ["e", parent, "", "reply"]];
        const event = { ...note(tags), id: other, pubkey: author, created_at: 1, content: "", sig: "0".repeat(128) };
        expect(parseNip10(event).reply?.id).not.toBe(parseNip10({ ...event, tags: [...tags].reverse() }).reply?.id);
        expect(normalize(event).parent.state).toBe("conflict");
    });
});
