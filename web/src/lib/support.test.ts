import { describe, expect, it } from "vitest";
import { allocatePayment, totalForPromotion } from "./support";

describe("visibility and author allocations", () => {
    it("keeps the one-sat minimum and conserves every sat", () => {
        expect(allocatePayment(1, 20)).toEqual({ promotion: 1, author: 0 });
        expect(allocatePayment(1000, 20)).toEqual({ promotion: 800, author: 200 });
        for (const share of [0, 20, 50, 99]) for (const total of [1, 2, 21, 210, 10000000]) {
            const split = allocatePayment(total, share);
            expect(split.promotion + split.author).toBe(total);
            expect(split.promotion).toBeGreaterThanOrEqual(1);
        }
    });
    it("finds the smallest total that funds the selected rank target", () => {
        for (const share of [0, 20, 50, 99]) for (const needed of [1, 21, 210, 2100]) {
            const total = totalForPromotion(needed, share);
            expect(allocatePayment(total, share).promotion).toBeGreaterThanOrEqual(needed);
            if (total > 1) expect(allocatePayment(total-1, share).promotion).toBeLessThan(needed);
        }
    });
    it("refuses invalid amounts and allocations", () => {
        for (const amount of [0, -1, NaN, 1.2]) expect(() => allocatePayment(amount, 20)).toThrow();
        for (const share of [-1, 100, NaN, 1.2]) expect(() => allocatePayment(21, share)).toThrow();
    });
});
