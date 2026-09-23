import { afterEach, describe, expect, it, vi } from "vitest";
import { requestInvoice } from "./promote";

afterEach(() => vi.unstubAllGlobals());

describe("promotion notification contact", () => {
    it("sends notify_pubkey only when one was requested", async () => {
        const bodies: Record<string, unknown>[] = [];
        vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
            bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            return new Response(JSON.stringify({
                invoice: "lnbc1example",
                payment_hash: "hash",
                amount_sats: 21,
                note_id: "a".repeat(64),
                expires_at: 2_000_000_000,
                promotion_sats: 21,
                billboard_fee_sats: 0,
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        }));

        await requestInvoice("note", 21, undefined, undefined, "b".repeat(64));
        await requestInvoice("note", 21);

        expect(bodies[0].notify_pubkey).toBe("b".repeat(64));
        expect(bodies[1]).not.toHaveProperty("notify_pubkey");
    });
});
