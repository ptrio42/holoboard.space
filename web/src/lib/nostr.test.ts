import { nip19 } from "@nostr-dev-kit/ndk";
import { describe, expect, it } from "vitest";
import { parsePubkey } from "./nostr";

describe("parsePubkey", () => {
    const hex = "12".repeat(32);

    it("accepts hex and npub values", () => {
        expect(parsePubkey(hex.toUpperCase())).toBe(hex);
        expect(parsePubkey(nip19.npubEncode(hex))).toBe(hex);
        expect(parsePubkey(`nostr:${nip19.npubEncode(hex)}`)).toBe(hex);
    });

    it("rejects other references", () => {
        expect(parsePubkey("not-a-key")).toBeNull();
        expect(parsePubkey(nip19.noteEncode(hex))).toBeNull();
    });
});
