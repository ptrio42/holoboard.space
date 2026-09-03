import { describe, expect, it } from "vitest";
import { parseLedger, toWeightMap } from "./sats";

const entry = (extra: Record<string, unknown>) => ({
    id: "a".repeat(64), sats_paid: 100, last_paid_at: 1, rank: 1, ...extra,
});

describe("ledger weights", () => {
    it("reads a weight the relay sent", () => {
        const ledger = parseLedger({ entries: [entry({ weight: 44 })] });
        expect(ledger.entries[0].weight).toBe(44);
        expect(toWeightMap(ledger).get("a".repeat(64))).toBe(44);
    });

    // A note paid long enough ago really is worth nothing, so zero has to
    // survive as zero rather than being mistaken for a missing field.
    it("keeps a weight of zero", () => {
        const ledger = parseLedger({ entries: [entry({ weight: 0 })] });
        expect(ledger.entries[0].weight).toBe(0);
        expect(toWeightMap(ledger).get("a".repeat(64))).toBe(0);
    });

    // An older relay sends no weight at all. Reading that as zero would draw
    // every row on the board as spent.
    it("treats a missing weight as unknown, not as nothing", () => {
        const ledger = parseLedger({ entries: [entry({})] });
        expect(ledger.entries[0].weight).toBeNull();
        expect(toWeightMap(ledger).has("a".repeat(64))).toBe(false);
    });

    it("ignores a weight that is not a number", () => {
        for (const bad of ["44", null, NaN, {}]) {
            expect(parseLedger({ entries: [entry({ weight: bad })] }).entries[0].weight).toBeNull();
        }
    });
});
