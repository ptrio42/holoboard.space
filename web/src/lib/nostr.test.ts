import { nip19 } from "@nostr-dev-kit/ndk";
import { describe, expect, it } from "vitest";
import { njumpUrl, parsePubkey, toNeventUri } from "./nostr";

describe("parsePubkey", () => {
    const hex = "12".repeat(32);

    it("accepts hex and npub values", () => {
        expect(parsePubkey(hex.toUpperCase())).toBe(hex);
        expect(parsePubkey(nip19.npubEncode(hex))).toBe(hex);
        expect(parsePubkey(`nostr:${nip19.npubEncode(hex)}`)).toBe(hex);
        expect(parsePubkey(`nostr:${nip19.nprofileEncode({ pubkey: hex, relays: ["wss://hint.example.com"] })}`)).toBe(hex);
    });

    it("rejects other references", () => {
        expect(parsePubkey("not-a-key")).toBeNull();
        expect(parsePubkey(nip19.noteEncode(hex))).toBeNull();
    });
});

it("shares event and profile pointers with safe relay hints", () => {
    const id = "a".repeat(64), author = "b".repeat(64), relay = "wss://hint.example.com";
    expect(nip19.decode(njumpUrl(id, "note", [relay], author).split("/").pop()!)).toMatchObject({ type: "nevent", data: { id, author, relays: [relay] } });
    expect(nip19.decode(njumpUrl(author, "npub", [relay]).split("/").pop()!)).toMatchObject({ type: "nprofile", data: { pubkey: author, relays: [relay] } });
    const uri = toNeventUri({ id, author, relays: [relay, `wss://hint.example.com/${"x".repeat(256)}`] });
    expect(nip19.decode(uri.slice(6))).toMatchObject({ type: "nevent", data: { id, relays: [relay] } });
});
