import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchExpired } from "./expired";

afterEach(() => vi.unstubAllGlobals());

const entry = {
    event: { id: "a".repeat(64), pubkey: "b".repeat(64), content: "Past note", tags: [], created_at: 1, kind: 1 },
    sats_paid: 210,
    last_paid_at: 123,
};

describe("expired archive", () => {
    it("preserves the original note and payment history and sends the pagination cursor", async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ entries: [entry], next_cursor: "next" })));
        vi.stubGlobal("fetch", fetchMock);
        const page = await fetchExpired("cursor/with+symbols");
        expect(page).toEqual({ entries: [{ event: entry.event, satsPaid: 210, lastPaidAt: 123 }], nextCursor: "next" });
        expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("cursor")).toBe("cursor/with+symbols");
    });

    it("accepts an empty archive", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"entries":[]}')));
        expect(await fetchExpired()).toEqual({ entries: [], nextCursor: null });
    });

    it("rejects failed requests and incomplete payment history", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
        await expect(fetchExpired()).rejects.toThrow("Could not load");
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ entries: [{ ...entry, sats_paid: "210" }] }))));
        await expect(fetchExpired()).rejects.toThrow("incomplete");
    });
});
