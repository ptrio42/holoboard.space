import { describe, expect, it } from "vitest";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { parentOf } from "./parent";

const event = (kind: number, tags: string[][]) => ({ kind, tags }) as unknown as NDKEvent;

const ROOT = "1111111111111111111111111111111111111111111111111111111111111111";
const PARENT = "2222222222222222222222222222222222222222222222222222222222222222";

describe("parentOf", () => {
    it("says nothing about a note that answers nothing", () => {
        expect(parentOf(event(1, []))).toBeNull();
        expect(parentOf(event(1, [["p", ROOT]]))).toBeNull();
        expect(parentOf(event(1111, [["K", "1"]]))).toBeNull();
    });

    it("finds what a kind:1 reply is replying to", () => {
        const found = parentOf(event(1, [["e", ROOT]]));
        expect(found?.label).toBe("In reply to");
        expect(found?.href).toContain("njump.me");
    });

    // NIP-10 marks the root when it marks anything, and the marker wins over
    // position.
    it("prefers the marked root over the first e tag", () => {
        const found = parentOf(event(1, [
            ["e", PARENT],
            ["e", ROOT, "", "root"],
        ]));
        expect(found?.href).toContain("note1");
        expect(parentOf(event(1, [["e", ROOT, "", "root"]]))?.href).toBe(found?.href);
    });

    // NIP-22 puts the root scope in uppercase tags, the immediate parent in
    // lowercase. A reader arriving cold wants the root.
    it("prefers the root scope of a comment", () => {
        const withBoth = parentOf(event(1111, [
            ["e", PARENT],
            ["E", ROOT],
            ["K", "1"],
        ]));
        const rootOnly = parentOf(event(1111, [["E", ROOT], ["K", "1"]]));

        expect(withBoth?.label).toBe("Comment on");
        expect(withBoth?.href).toBe(rootOnly?.href);
    });

    it("falls back to the immediate parent when a comment has no root tag", () => {
        const found = parentOf(event(1111, [["e", PARENT], ["k", "1"]]));
        expect(found?.label).toBe("Comment on");
        expect(found?.href).toContain("njump.me");
    });

    it("follows a comment scoped to something outside nostr", () => {
        const found = parentOf(event(1111, [["I", "https://example.com/article"], ["K", "web"]]));
        expect(found?.href).toBe("https://example.com/article");
    });

    // An I tag can hold a podcast guid or an isbn, which is not a link.
    it("refuses a scope that is not a web address", () => {
        expect(parentOf(event(1111, [["I", "isbn:9780316769488"]]))).toBeNull();
        expect(parentOf(event(1111, [["I", "javascript:alert(1)"]]))).toBeNull();
    });

    it("ignores empty tag values", () => {
        expect(parentOf(event(1, [["e", ""]]))).toBeNull();
        expect(parentOf(event(1111, [["E", ""]]))).toBeNull();
    });
});
