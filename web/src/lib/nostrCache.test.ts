import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { NostrCache } from "./nostrCache";
import { profileMetadata } from "./nostrReads";

const key = generateSecretKey();
const signed = (kind = 1, created_at = 100, tags: string[][] = [], content = "note") => finalizeEvent({ kind, created_at, tags, content }, key);
afterEach(() => vi.useRealTimers());
describe("verified bounded read cache", () => {
    it("rejects forged IDs and retains all signed tags before applying limits", () => {
        const cache = new NostrCache();
        const target = signed(1, 100, Array.from({ length: 12 }, (_, i) => ["e", `id${i}`]));
        cache.put(target); cache.put(signed(1, 200, [["e", "other"]]));
        cache.put({ ...target, id: "f".repeat(64) });
        expect(cache.query({ authors: [target.pubkey], "#e": ["id11"], limit: 1 }).map((event) => event.id)).toEqual([target.id]);
        expect(cache.stats().entries).toBe(2);
    });
    it("selects replaceable events by timestamp and lower ID and expires profiles", () => {
        vi.useFakeTimers();
        const cache = new NostrCache();
        const candidates = [signed(0, 100, [], '{"name":"one"}'), signed(0, 100, [], '{"name":"two"}')].sort((a, b) => a.id.localeCompare(b.id));
        cache.put(candidates[1]); cache.put(candidates[0]); cache.put(candidates[1]);
        expect(cache.query({ kinds: [0] })[0].id).toBe(candidates[0].id);
        vi.advanceTimersByTime(15 * 60_000 + 1);
        expect(cache.query({ kinds: [0] })).toEqual([]);
    });
    it("honours author-bound deletions and ignores someone else's deletion", () => {
        const cache = new NostrCache();
        const note = signed(); cache.put(note);
        const foreign = finalizeEvent({ kind: 5, created_at: 101, tags: [["e", note.id]], content: "" }, generateSecretKey());
        cache.put(foreign); expect(cache.query({ ids: [note.id] })).toHaveLength(1);
        cache.put(signed(5, 102, [["e", note.id]], ""));
        expect(cache.query({ ids: [note.id] })).toEqual([]);
    });
    it("bounds retained bytes and rejects oversized events", () => {
        const cache = new NostrCache();
        for (let i = 0; i < 40; i++) cache.put(signed(1, i, [], "x".repeat(80_000)));
        expect(cache.stats().bytes).toBeLessThanOrEqual(8_388_608);
        expect(cache.stats().entries).toBeLessThan(40);
        cache.put(signed(1, 500, [], "x".repeat(300_000)));
        expect(cache.query({ since: 500 })).toEqual([]);
    });
    it("sanitises malformed signed profile fields without verification claims", () => {
        const profile = profileMetadata(signed(0, 100, [], '{"name":42,"display_name":{},"picture":"javascript:alert(1)","nip05":"claimed@example.com"}'));
        expect(profile?.name).toBeUndefined(); expect(profile?.displayName).toBeUndefined(); expect(profile?.picture).toBeUndefined();
        expect(profile?.nip05).toBe("claimed@example.com");
        expect(profileMetadata(signed(0, 100, [], "null"))).toBeUndefined();
    });
});
