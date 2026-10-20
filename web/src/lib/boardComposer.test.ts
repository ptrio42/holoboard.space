import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { neventEncode, noteEncode } from "nostr-tools/nip19";
import { anonymousTags, boardPostTemplate, boardReference, boardReferences, classifyBoardInput, createGuestAuthor, isAnonymousPost } from "./boardComposer";

const source = finalizeEvent({ kind: 1, created_at: 1700000000, tags: [], content: "Original" }, generateSecretKey());
const reference = neventEncode({ id: source.id, author: "a".repeat(64) });
describe("shared board input", () => {
    it("recognizes only standalone IDs and known routes as the original", () => {
        for (const text of [source.id, noteEncode(source.id), reference, `nostr:${reference}`, ` https://njump.me/${reference} `]) {
            expect(classifyBoardInput(text).mode).toBe("original");
            expect(boardReference(text)?.id).toBe(source.id);
        }
        for (const text of [`Comment ${reference}`, `Comment ${source.id}`, `https://example.com/${reference}`, "A text post", "https://example.com/story"]) expect(classifyBoardInput(text).mode).toBe("post");
        expect(classifyBoardInput(reference, "quote").mode).toBe("post");
    });
    it("keeps IDs in prose as text and does not extract Nostr from arbitrary URLs", () => {
        expect(boardReferences(`Text ${source.id} https://example.com/${reference}`)).toEqual([]);
        expect(boardReferences(`Look (nostr:${reference}). Also https://njump.me/${reference}`)).toHaveLength(2);
    });
    it("creates one q per distinct source and uses its verified author", async () => {
        const text = `Comment nostr:${reference}\nhttps://njump.me/${reference}`;
        const template = await boardPostTemplate(text, async () => source, false);
        expect(template.tags).toEqual([["q", source.id, "", source.pubkey]]);
        expect(template.tags.some(tag => tag[0] === "e")).toBe(false);
        expect(template.content).not.toContain(reference);
        expect(template.content.match(/nostr:nevent1/g)).toHaveLength(2);
        expect(text).toContain(reference);
    });
    it("fails closed for unverified quoted content", async () => {
        await expect(boardPostTemplate(reference, async () => ({ ...source, content: "Modified" }), false)).rejects.toThrow("verify");
        await expect(boardPostTemplate(reference, async () => { throw new Error("offline"); }, false)).rejects.toThrow("offline");
    });
    it("signs a guest post with self-reported attribution and an optional export", async () => {
        const guest = createGuestAuthor(), other = createGuestAuthor();
        const event = guest.sign(await boardPostTemplate("A guest post", async () => source, true));
        expect(event.pubkey).toBe(guest.pubkey);
        expect(event.pubkey).not.toBe(other.pubkey);
        expect(event.tags).toEqual(anonymousTags());
        expect(isAnonymousPost(event)).toBe(true);
        expect(isAnonymousPost({ tags: [["l", "anonymous", "somewhere-else"]] })).toBe(false);
        expect(guest.export()).toMatch(/^nsec1/);
        expect(JSON.stringify(event)).not.toContain(guest.export());
        guest.destroy(); other.destroy();
    });
});
