import { describe, expect, it } from "vitest";
import { initialBillboard, parseBillboard, validBillboard } from "./billboard";
import { parseLedger } from "./sats";

describe("billboard content", () => {
    it("accepts only a fragment of the original note", () => {
        const config = initialBillboard("Hello world");
        expect(validBillboard(config, "Hello world", [])).toBe(true);
        expect(validBillboard({ ...config, text: "Another slogan" }, "Hello world", [])).toBe(false);
        expect(validBillboard({ ...config, text: " " }, "Hello world", [])).toBe(false);
    });
    it("counts Unicode characters consistently with the relay", () => {
        const content = "😀".repeat(161);
        const config = initialBillboard(content);
        expect(Array.from(config.text)).toHaveLength(160);
        expect(content.includes(config.text)).toBe(true);
        expect(parseBillboard({ ...config, text: content })).toBeUndefined();
    });
    it("starts with the entire short note, including line breaks", () => {
        const content = "First line\nSecond line";
        expect(initialBillboard(content).text).toBe(content);
    });
    it("requires an image from the same note", () => {
        const config = { ...initialBillboard("Hello"), template: "image-led" as const, image: "https://example.com/a.png" };
        expect(validBillboard(config, "Hello", [config.image])).toBe(true);
        expect(validBillboard(config, "Hello", [])).toBe(false);
        expect(parseBillboard({ ...config, image: "javascript:alert(1)" })).toBeUndefined();
    });
    it("keeps plain rows when metadata is absent or unsupported", () => {
        const base = { id: "note", sats_paid: 10, weight: 8, rank: 1 };
        expect(parseLedger({ entries: [base] }).entries[0].billboard).toBeUndefined();
        expect(parseLedger({ entries: [{ ...base, billboard: { ...initialBillboard("Hello"), template: "unknown" } }] }).entries[0].billboard).toBeUndefined();
        expect(parseLedger({ entries: [{ ...base, billboard: initialBillboard("Hello") }] }).entries[0].billboard?.text).toBe("Hello");
    });
});
