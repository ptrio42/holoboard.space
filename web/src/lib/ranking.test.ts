import { describe, expect, it } from "vitest";
import { amountToPassWeight } from "./ranking";

describe("ranking target amounts", () => {
    it("charges one sat more than the current target weight", () => {
        expect(amountToPassWeight(2_100)).toBe(2_101);
    });

    it("subtracts weight the promoted note already has", () => {
        expect(amountToPassWeight(2_100, 850)).toBe(1_251);
    });

    it("keeps the relay's one-sat minimum when the target is already reached", () => {
        expect(amountToPassWeight(850, 2_100)).toBe(1);
    });
});
