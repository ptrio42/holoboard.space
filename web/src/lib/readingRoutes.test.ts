import { expect, it } from "vitest";
import { discussionHref, discussionRoute, profileHref, profileRoute, readingReturnPath } from "./readingRoutes";
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
});
