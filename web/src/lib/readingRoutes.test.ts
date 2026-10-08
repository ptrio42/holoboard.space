import { expect, it } from "vitest";
import { discussionHref, discussionRoute, profileHref, profileRoute, readingReturnPath } from "./readingRoutes";
import { decode, neventEncode, noteEncode, nprofileEncode, npubEncode, nsecEncode } from "nostr-tools/nip19";
import { pointerRelays } from "./nostrPointers";
const id = "a".repeat(64), author = "b".repeat(64);
it("preserves profile/discussion returns and safe relay hints with bounded nesting", () => {
    const discussion = discussionHref(id, author, "/waiting?view=hot");
    const profile = profileHref(author, discussion, ["wss://hint.example.com", "ws://localhost"]);
    expect(profileRoute(profile)).toEqual({ pubkey: author, from: discussion, hints: ["wss://hint.example.com"] });
    expect(discussionRoute(discussionHref(id, author, profile))?.from).toBe(profile);
    let nested = profile;
    for (let i = 0; i < 50; i++) nested = profileHref(author, discussionHref(id, author, nested));
    expect(nested.length).toBeLessThan(2000);
});
it("rejects external, malformed and arbitrary return routes", () => {
    for (const value of ["https://evil.example", "//evil.example", "/\\evil.example", "/profile/invalid", "/discussion/invalid", "/help", "/profile/../unsafe"]) expect(readingReturnPath(value)).toBe("/");
    expect(profileRoute(`/profile/${author}?from=https://evil.example&relay=ws://127.0.0.1`)).toMatchObject({ from: "/", hints: [] });
    expect(profileRoute(`/profile/${author.toUpperCase()}`)).toBeNull();
});
it("keeps generated routes valid when relay hints would overflow the URL budget", () => {
    const href = profileHref(author, discussionHref(id), Array.from({ length: 4 }, (_, i) => `wss://hint${i}.example.com/?q=${"x".repeat(1800)}`));
    expect(href.length).toBeLessThanOrEqual(4096);
    expect(profileRoute(href)?.pubkey).toBe(author);
    expect(profileRoute(href)?.hints).toEqual([]);
});

it("embeds exact event identity, author and relay hints in nevent and nprofile", () => {
    const hints = ["wss://hint.example.com/events", "wss://hint.example.com/events/", "wss://second.example.com"];
    const discussion = discussionHref(id, author, "/", hints);
    expect(discussion).toMatch(/^\/discussion\/nevent1/);
    expect(decode(discussion.split("/")[2])).toMatchObject({ type: "nevent", data: { id, author, relays: [hints[0], hints[2]] } });
    const profile = profileHref(author, discussion, hints);
    expect(profile).toMatch(/^\/profile\/nprofile1/);
    expect(profileRoute(profile)).toEqual({ pubkey: author, hints: [hints[0], hints[2]], from: discussion });
    expect(discussionRoute(discussion)).toEqual({ focusId: id, author, hints: [hints[0], hints[2]], from: "/" });
});

it("accepts legacy hex, note and npub routes and keeps pointer authors ahead of query hints", () => {
    expect(discussionRoute(`/discussion/${id}?author=${author}&relay=wss://hint.example.com`)).toMatchObject({ focusId: id, author, hints: ["wss://hint.example.com"] });
    expect(discussionRoute(`/discussion/${noteEncode(id)}`)?.focusId).toBe(id);
    expect(profileRoute(`/profile/${npubEncode(author)}`)?.pubkey).toBe(author);
    const path = `/discussion/${neventEncode({ id, author })}?author=${id}`;
    expect(discussionRoute(path)?.author).toBe(author);
    expect(readingReturnPath(path)).toBe(path);
    const withKind = `/discussion/${neventEncode({ id, author, kind: 1, relays: ["wss://hint.example.com"] })}`;
    expect(readingReturnPath(withKind)).toBe(withKind);
});

it("rejects private keys, wrong pointer types, bad checksums and oversized routes", () => {
    const profile = nprofileEncode({ pubkey: author }), event = neventEncode({ id }), secret = nsecEncode(new Uint8Array(32).fill(1));
    for (const pointer of [profile, secret, event.slice(0, -1) + (event.endsWith("q") ? "p" : "q"), "nevent1" + "x".repeat(5000)]) expect(discussionRoute(`/discussion/${pointer}`)).toBeNull();
    for (const pointer of [event, secret, noteEncode(id)]) expect(profileRoute(`/profile/${pointer}`)).toBeNull();
});

it("filters embedded hints and enforces the TLV byte limit and source count", () => {
    const relay = "wss://hint.example.com/", boundary = relay + "x".repeat(255 - relay.length);
    const hints = ["wss://127.0.0.1", "ws://evil.example.com", "wss://relay.local", "wss://user:password@hint.example.com", boundary, boundary + "x", ...Array.from({ length: 9 }, (_, i) => `wss://hint${i}.example.com`)];
    const href = discussionHref(id, author, "/", hints);
    expect(discussionRoute(href)?.hints).toEqual([boundary, ...hints.slice(6, 9)]);
    expect(pointerRelays([boundary + "x"])).toEqual([]);
    const unsafe = `/profile/${nprofileEncode({ pubkey: author, relays: hints.filter(value => value.length <= 255) })}`;
    expect(profileRoute(unsafe)?.hints).toEqual([boundary, ...hints.slice(6, 9)]);
    expect(profileRoute(readingReturnPath(unsafe))?.hints).toEqual(profileRoute(unsafe)?.hints);
});

it("bounds nested returns with maximum-sized valid pointers", () => {
    const hints = Array.from({ length: 4 }, (_, i) => `wss://hint${i}.example.com/${"x".repeat(231)}`);
    let path = "/waiting?view=hot";
    for (let i = 0; i < 10; i++) {
        path = profileHref(author, discussionHref(id, author, path, hints), hints);
        expect(path.length).toBeLessThanOrEqual(4096);
        expect(profileRoute(path)?.pubkey).toBe(author);
    }
});
