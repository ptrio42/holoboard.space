import { describe, expect, it } from "vitest";
import { nip19 } from "@nostr-dev-kit/ndk";
import { linkLabel, noteAttachments, quoteExcerpt, quoteReference } from "./noteAttachments";

const id = "a".repeat(64);
const author = "b".repeat(64);

describe("advertising destinations", () => {
    it("keeps distinct links visible without duplicating media URLs", () => {
        const result = noteAttachments("Buy here https://example.com/shop. https://example.com/shop https://example.com/a.png");
        expect(result.links).toEqual(["https://example.com/shop"]);
    });
    it("deduplicates inline, client URL and tagged references to the same note", () => {
        const note = nip19.noteEncode(id);
        const event = nip19.neventEncode({ id, relays: ["wss://example.com"] });
        const result = noteAttachments(`nostr:${note} https://njump.me/${event}`, [["q", id, "wss://example.com"]]);
        expect(result.quotes).toHaveLength(1);
        expect(result.quotes[0].filter).toEqual({ ids: [id] });
        expect(result.quotes[0].relays).toEqual(["wss://example.com"]);
        expect(result.links).toEqual([]);
    });
    it("supports addressable quotes and ignores profiles, invalid references and self quotes", () => {
        const address = nip19.naddrEncode({ kind: 30023, pubkey: author, identifier: "launch", relays: [] });
        expect(quoteReference(address)?.filter).toEqual({ kinds: [30023], authors: [author], "#d": ["launch"] });
        expect(quoteReference(nip19.npubEncode(author))).toBeNull();
        expect(quoteReference("note1invalid")).toBeNull();
        expect(noteAttachments(`nostr:${nip19.noteEncode(id)}`, [["q", id]], id).quotes).toEqual([]);
    });
    it("retains relay hints and reads q tags without requiring an inline reference", () => {
        const result = noteAttachments("A new launch", [["q", id, "wss://hint.example"], ["e", author]]);
        expect(result.quotes).toHaveLength(1);
        expect(result.quotes[0].relays).toEqual(["wss://hint.example"]);
    });
    it("uses readable destinations and bounded plain excerpts without recursive embeds", () => {
        expect(linkLabel("https://example.com/shop?q=1")).toBe("example.com/shop?q=1");
        expect(quoteExcerpt(`Hello\nhttps://example.com/a.png nostr:${nip19.noteEncode(id)}`)).toBe("Hello [Image] [Note reference]");
        expect(Array.from(quoteExcerpt("😀".repeat(230)))).toHaveLength(220);
    });
});
