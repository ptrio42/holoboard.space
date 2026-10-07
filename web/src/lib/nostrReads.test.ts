import { expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Filter } from "nostr-tools";
import { queryNostr, type QueryResult } from "./nostrTransport";
import { authorRelays, readNostr, relayList } from "./nostrReads";

vi.mock("./nostrTransport", () => ({ queryNostr: vi.fn() }));
const answer = (events: QueryResult["events"], complete = true): QueryResult => ({ events, complete, sources: {}, relays: { "wss://index.example.com": complete ? "eose" : "timeout" } });
it("keeps a signed relay list observed before timeout and caches it", async () => {
    const key = generateSecretKey();
    const list = finalizeEvent({ kind: 10002, created_at: 100, content: "", tags: [["r", "wss://write.example.com", "write"], ["r", "wss://read.example.com", "read"]] }, key);
    vi.mocked(queryNostr).mockResolvedValue(answer([list], false));
    expect((await relayList(list.pubkey))?.id).toBe(list.id);
    const calls = vi.mocked(queryNostr).mock.calls.length;
    expect(await authorRelays(list.pubkey)).toEqual(["wss://write.example.com"]);
    expect(vi.mocked(queryNostr).mock.calls.length).toBe(calls);
});
it("discovers NIP-65 on a reference hint and queries the author's additional outbox", async () => {
    const key = generateSecretKey(), pubkey = getPublicKey(key);
    const note = finalizeEvent({ kind: 1, created_at: 100, content: "Only in the outbox", tags: [] }, key);
    const list = finalizeEvent({ kind: 10002, created_at: 100, content: "", tags: [["r", "wss://outbox.example.com", "write"]] }, key);
    const calls: string[][] = [];
    vi.mocked(queryNostr).mockImplementation(async (filter: Filter, relays, options) => {
        calls.push(relays);
        if (filter.kinds?.includes(10002)) {
            expect(relays).toContain("wss://hint.example.com");
            return answer([list]);
        }
        if (relays.includes("wss://outbox.example.com")) { options?.onEvent?.(note); return answer([note]); }
        return answer([]);
    });
    const result = await readNostr({ ids: [note.id] }, ["wss://hint.example.com"], pubkey);
    expect(result.events.map((event) => event.id)).toEqual([note.id]);
    expect(calls.some((relays) => relays.includes("wss://outbox.example.com"))).toBe(true);
});
