import { expect, it } from "vitest";
import { nip19 } from "nostr-tools";
import { threadContext, threadHref } from "./thread";
import { quoteReference, noteAttachments } from "./noteAttachments";
const root = "a".repeat(64), parent = "b".repeat(64), author = "c".repeat(64);
it("separates root and direct parent independently of tag order", () => {
    expect(threadContext({ kind: 1, tags: [["e", root, "", "root"], ["e", parent, "wss://example.com", "reply", author]] }))
        .toMatchObject({ root: { value: root }, parent: { value: parent, author, relays: ["wss://example.com"] } });
    expect(threadContext({ kind: 1, tags: [["e", root], ["e", parent]] })).toMatchObject({ root: { value: root }, parent: { value: parent } });
});
it("keeps addressable NIP-22 scopes distinct from their parents", () => {
    const context = threadContext({ kind: 1111, tags: [["A", `30023:${author}:part:one`], ["e", parent]] });
    expect(context.root?.type).toBe("address"); expect(context.parent?.value).toBe(parent);
    const pointer = nip19.decode(threadHref(context.root!).split("/").at(-1)!);
    expect(pointer.type).toBe("naddr");
});
it("preserves nevent and q-tag authors for outbox discovery", () => {
    expect(quoteReference(nip19.neventEncode({ id: root, author }))?.author).toBe(author);
    expect(noteAttachments("", [["q", root, "wss://example.com", author]]).quotes[0].author).toBe(author);
});
