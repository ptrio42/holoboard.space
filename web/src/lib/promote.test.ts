import { afterEach, describe, expect, it, vi } from "vitest";
import { checkProgress, fetchNotePreview, requestInvoice } from "./promote";

afterEach(() => vi.unstubAllGlobals());

describe("mock promotion invoices", () => {
    it.each(["lnbc21...mock_invoice", "LNBC210...MOCK_INVOICE"])("rejects the backend placeholder %s before offering payment", async (invoice) => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
            invoice, payment_hash: "hash", amount_sats: 21,
        }), { status: 200 })));
        await expect(requestInvoice("note", 21)).rejects.toThrow("test invoices");
    });
});

describe("preview author allocation", () => {
    it.each([
        { active: false, sats_paid: 0, expected: 20 },
        { active: true, sats_paid: 210, expected: 0 },
        { active: false, sats_paid: 210, expected: 0 },
        { active: true, sats_paid: 210, author_share: 0, expected: 0 },
        { active: true, sats_paid: 210, author_share: 35, expected: 35 },
    ])("preserves explicit shares and distinguishes new from legacy campaigns: %j", async ({ expected, ...campaign }) => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
            ...campaign,
            event: { id: "a".repeat(64), pubkey: "b".repeat(64), kind: 1, created_at: 1700000000, tags: [], content: "Preview", sig: "c".repeat(128) },
            billboard_fee_sats: 100, images: [],
        }), { status: 200 })));
        expect((await fetchNotePreview("a".repeat(64))).authorShare).toBe(expected);
    });
});

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

describe("visibility payment confirmation", () => {
    it("reports the current invoice credit without including other boosts or author support", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
            settled: true, pending: false, sats_paid: 10000,
            receipt: {promotion_sats: 168, billboard_fee_sats: 100, billboard_applied: true},
        }), {status: 200})));
        const progress = await checkProgress("hash", "note");
        expect(progress.settled).toBe(true);
        expect(progress.satsPaid).toBe(168);
        expect(progress.billboardApplied).toBe(true);
    });
    it("does not infer payment from a note's growing aggregate", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
            pending: true, settled: false, sats_paid: 10000,
        }), {status: 200})));
        const progress = await checkProgress("hash", "note");
        expect(progress.settled).toBe(false);
        expect(progress.satsPaid).toBe(0);
    });
});
