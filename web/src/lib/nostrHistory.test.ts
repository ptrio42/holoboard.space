import { expect, it } from "vitest";
import type { Event } from "nostr-tools";
import { historyPageResult } from "./nostrHistory";
import type { QueryResult } from "./nostrTransport";
const event = (id: string, created_at: number) => ({ id, created_at }) as Event;
const result = (events: Event[], complete = true): QueryResult => ({ events, complete, sources: Object.fromEntries(events.map((event) => [event.id, ["wss://example.com"]])), relays: { "wss://example.com": complete ? "eose" : "timeout" } });
it("uses inclusive boundaries and deduplicates already returned ties", () => {
    const first = historyPageResult(result([event("a", 100), event("b", 99)]), 2);
    expect(first.exhausted).toBe(false); expect(first.next?.until).toBe(99);
    const next = historyPageResult(result([event("b", 99), event("c", 98)]), 2, first.next);
    expect(next.events.map((event) => event.id)).toEqual(["c"]); expect(next.next?.until).toBe(98);
});
it("expands a saturated timestamp instead of skipping unseen events", () => {
    const page = historyPageResult(result([event("a", 100), event("b", 100)]), 2, { until: 100, boundaryIds: ["a", "b"], limit: 2 });
    expect(page.next).toEqual({ until: 100, boundaryIds: ["a", "b"], limit: 4 });
    expect(page.exhausted).toBe(false);
});
it("does not call a timed-out empty page exhausted", () => {
    expect(historyPageResult(result([], false), 100).exhausted).toBe(false);
});
it("keeps the common cursor above every full relay page's unseen history", () => {
    const answer = result([event("a", 100), event("b", 99), event("c", 90), event("d", 80)]);
    answer.sources = { a: ["wss://a.example.com"], b: ["wss://a.example.com"], c: ["wss://b.example.com"], d: ["wss://b.example.com"] };
    answer.relays = { "wss://a.example.com": "eose", "wss://b.example.com": "eose" };
    expect(historyPageResult(answer, 2).next?.until).toBe(99);
});
it("retains partial events without advancing past a failed relay", () => {
    const page = historyPageResult(result([event("a", 100), event("b", 99)], false), 2);
    expect(page.events).toHaveLength(2); expect(page.next).toBeUndefined(); expect(page.exhausted).toBe(false);
});
