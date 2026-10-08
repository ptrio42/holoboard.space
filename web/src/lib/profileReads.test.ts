import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, type Event } from "nostr-tools";
import { queryNostr, type QueryResult } from "./nostrTransport";
import { cachedProfileValue, profileRelayHints, readProfileValue, ProfileReader } from "./profileReads";
import { nostrCache } from "./nostrCache";
import { profileMetadata } from "./profileMetadata";
vi.mock("./nostrTransport", () => ({ queryNostr: vi.fn() }));
const answer = (events: Event[] = [], complete = true): QueryResult => ({ events, complete, sources: {}, relays: { "wss://checked.example.com": complete ? "eose" : "timeout" } });
function fixtures() {
    const key = generateSecretKey();
    const make = (content: string, created_at = 100, kind = 0, tags: string[][] = []) => finalizeEvent({ content, created_at, kind, tags }, key);
    const old = make('{"name":"Saved author"}');
    return { make, old, pubkey: old.pubkey };
}
beforeEach(() => { vi.mocked(queryNostr).mockReset(); vi.mocked(queryNostr).mockResolvedValue(answer()); });
afterEach(() => vi.useRealTimers());
describe("shared bounded profile reads", () => {
    it("exports only verified public write destinations as profile pointer hints", () => {
        const { make, pubkey } = fixtures();
        nostrCache.put(make("", 100, 10050, [["relay", "wss://dm.example.com"]]));
        expect(profileRelayHints(pubkey)).toEqual([]);
        nostrCache.put(make("", 100, 10002, [["r", "wss://write.example.com", "write"], ["r", "wss://both.example.com"], ["r", "wss://read.example.com", "read"], ["r", "ws://unsafe.example.com", "write"]]));
        expect(profileRelayHints(pubkey)).toEqual(["wss://write.example.com", "wss://both.example.com"]);
        expect(queryNostr).not.toHaveBeenCalled();
    });
    it("makes verified cached author names available synchronously without extra queries", async () => {
        const { old, make, pubkey } = fixtures();
        expect(cachedProfileValue(pubkey)).toBeUndefined();
        nostrCache.put(old);
        expect(cachedProfileValue(pubkey)).toMatchObject({ name: "Saved author" });
        expect(await readProfileValue(pubkey)).toEqual(cachedProfileValue(pubkey));
        const malformed = make("not metadata", 200); nostrCache.put(malformed);
        expect(cachedProfileValue(pubkey)).toBeUndefined();
        expect(await readProfileValue(pubkey)).toBeUndefined();
        expect(queryNostr).not.toHaveBeenCalled();
    });
    it("shows cache immediately and chooses the latest signed profile independently of arrivals", async () => {
        const { old, make, pubkey } = fixtures(); nostrCache.put(old);
        const reader = new ProfileReader(); const one = reader.open(pubkey), two = reader.open(pubkey);
        expect(one.snapshot()).toMatchObject({ cached: true, profile: { name: "Saved author" }, state: "idle" });
        const newest = [make('{"name":"One"}', 200), make('{"name":"Two"}', 200)].sort((a, b) => a.id.localeCompare(b.id));
        vi.mocked(queryNostr).mockImplementation(async (filter, _urls, options) => {
            if (filter.kinds?.[0] === 10002) return answer();
            for (const event of [newest[1], newest[0], old]) options?.onEvent?.(event);
            return answer([newest[1], old, newest[0]]);
        });
        await Promise.all([one.refresh(), two.refresh()]);
        expect(queryNostr).toHaveBeenCalledTimes(2);
        expect(one.snapshot()).toMatchObject({ event: { id: newest[0].id }, cached: false, state: "settled" });
        expect(two.snapshot().profile).toEqual(one.snapshot().profile);
        one.close(); expect(reader.stats()).toEqual({ sessions: 1, handles: 1 });
        two.close(); expect(reader.stats()).toEqual({ sessions: 0, handles: 0 });
    });
    it("uses write relays and safe hints, retaining observed metadata when sources time out", async () => {
        const { make, pubkey } = fixtures(); const profile = make('{"about":"Found before deadline"}');
        const list = make("", 100, 10002, [["r", "wss://outbox.example.com", "write"], ["r", "wss://inbox.example.com", "read"]]);
        vi.mocked(queryNostr).mockImplementation(async (filter, urls) => {
            if (filter.kinds?.[0] === 10002) { expect(urls).toContain("wss://hint.example.com"); return answer([list], false); }
            return urls.includes("wss://outbox.example.com") ? answer([profile], false) : answer();
        });
        const handle = new ProfileReader().open(pubkey, ["ws://localhost", "wss://hint.example.com"]);
        await handle.refresh();
        expect(handle.snapshot()).toMatchObject({ profile: { about: "Found before deadline" }, state: "partial", routing: { "wss://checked.example.com": "timeout" } });
        expect(vi.mocked(queryNostr).mock.calls.some(([, urls]) => urls.includes("wss://inbox.example.com") || urls.includes("ws://localhost"))).toBe(false);
        handle.close();
    });
    it("ignores forged and foreign profiles and exposes malformed latest metadata", async () => {
        const { old, make, pubkey } = fixtures(); nostrCache.put(old);
        const malformed = make("null", 200), foreign = fixtures().old;
        vi.mocked(queryNostr).mockImplementation(async filter => filter.kinds?.[0] === 0 ? answer([{ ...make('{"name":"Forged"}', 300), id: "f".repeat(64) }, foreign, malformed]) : answer());
        const handle = new ProfileReader().open(pubkey); await handle.refresh();
        expect(handle.snapshot()).toMatchObject({ malformed: true, event: { id: malformed.id }, profile: undefined });
        handle.close();
    });
    it("cancels only the last view and joins shutdown before reopening", async () => {
        const { pubkey } = fixtures(); const reader = new ProfileReader(); let aborted = 0;
        vi.mocked(queryNostr).mockImplementation((_filter, _urls, options) => new Promise(resolve => {
            options!.signal!.addEventListener("abort", () => { aborted++; resolve(answer([], false)); }, { once: true });
        }));
        const first = reader.open(pubkey), second = reader.open(pubkey);
        const job = first.refresh();
        await vi.waitFor(() => expect(queryNostr).toHaveBeenCalledTimes(2));
        first.close(); expect(aborted).toBe(0);
        second.close(); expect(aborted).toBe(2);
        const reopened = reader.open(pubkey);
        vi.mocked(queryNostr).mockResolvedValue(answer());
        await reopened.refresh(); await job;
        expect(reopened.snapshot().state).toBe("settled");
        reopened.close(); expect(reader.stats()).toEqual({ sessions: 0, handles: 0 });
    });
    it("bounds retained sessions and oversized metadata, and clears timed-out loading", async () => {
        const reader = new ProfileReader();
        const handles = Array.from({ length: 64 }, (_, i) => reader.open(i.toString(16).padStart(64, "0")));
        expect(() => reader.open("f".repeat(64))).toThrow("budget"); handles.forEach(handle => handle.close());
        const { pubkey, make } = fixtures();
        vi.mocked(queryNostr).mockImplementation(async filter => filter.kinds?.[0] === 0 ? answer([make(JSON.stringify({ about: "x".repeat(22000) }))]) : answer());
        const handle = reader.open(pubkey); await handle.refresh();
        expect(handle.snapshot()).toMatchObject({ limited: true, state: "partial", profile: undefined }); handle.close();
        vi.useFakeTimers();
        vi.mocked(queryNostr).mockImplementation((_filter, _urls, options) => new Promise(resolve => options!.signal!.addEventListener("abort", () => resolve(answer([], false)), { once: true })));
        const timeout = reader.open(fixtures().pubkey), job = timeout.refresh();
        await vi.advanceTimersByTimeAsync(12001); await job;
        expect(timeout.snapshot().state).toBe("partial"); timeout.close();
    });
    it("sanitises websites and treats claimed addresses as ordinary metadata", () => {
        for (const website of ["javascript:alert(1)", "data:text/html,unsafe", "https://user:secret@example.com", "https://example.com\nunsafe"]) {
            expect(profileMetadata({ content: JSON.stringify({ website }) })?.website).toBeUndefined();
        }
        expect(profileMetadata({ content: '{"website":"https://example.com/path","nip05":"claimed@example.com"}' })).toMatchObject({ website: "https://example.com/path", nip05: "claimed@example.com" });
    });
    it("does not extend cached metadata freshness merely by opening a profile", () => {
        vi.useFakeTimers();
        const { old, pubkey } = fixtures(); nostrCache.put(old);
        vi.advanceTimersByTime(14 * 60000);
        const handle = new ProfileReader().open(pubkey);
        expect(handle.snapshot().profile?.name).toBe("Saved author");
        handle.close(); vi.advanceTimersByTime(60001);
        expect(nostrCache.query({ kinds: [0], authors: [pubkey] })).toEqual([]);
    });
});
