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

describe("additional billboard templates", () => {
    it.each(["terminal", "split-flap", "glitch", "poster"] as const)("accepts %s and preserves source-only text", template => {
        const config = { ...initialBillboard("Hello world"), template };
        expect(parseBillboard(config)?.template).toBe(template);
        expect(validBillboard(config, "Hello world", [])).toBe(true);
        expect(validBillboard({ ...config, text: "Invented" }, "Hello world", [])).toBe(false);
    });
    it("allows an optional original image for a poster", () => {
        const config = { ...initialBillboard("Hello"), template: "poster" as const };
        const image = "https://example.com/a.png";
        expect(validBillboard(config, "Hello", [image])).toBe(true);
        expect(validBillboard({ ...config, image }, "Hello", [image])).toBe(true);
        expect(validBillboard({ ...config, image }, "Hello", [])).toBe(false);
        expect(parseBillboard({ ...config, image: "javascript:alert(1)" })).toBeUndefined();
    });
    it("requires every slide to come from the original note", () => {
        const config = { ...initialBillboard("First"), template: "slides" as const, slides: ["First", "Second"] };
        expect(validBillboard(config, "First\nSecond", [])).toBe(true);
        expect(validBillboard(config, "First", [])).toBe(false);
        expect(parseBillboard({ ...config, text: "Second" })).toBeUndefined();
        expect(parseBillboard({ ...config, slides: ["First", ""] })).toBeUndefined();
        expect(parseBillboard({ ...config, slides: ["First", "Second", "Third", "Fourth"] })).toBeUndefined();
        expect(parseBillboard({ ...config, slides: [] })).toBeUndefined();
        expect(parseBillboard({ ...config, slides: undefined })).toBeUndefined();
        expect(parseBillboard({ ...config, slides: ["First", 123] })).toBeUndefined();
    });
    it("applies the shared 160 character limit to Unicode slide fragments", () => {
        const first = "😀".repeat(80), second = "界".repeat(80);
        const config = { ...initialBillboard(first), template: "slides" as const, slides: [first, second] };
        expect(validBillboard(config, first + second, [])).toBe(true);
        expect(parseBillboard({ ...config, slides: [first, second + "!"] })).toBeUndefined();
        const parsed = parseBillboard(config)!;
        parsed.slides![0] = "changed";
        expect(config.slides[0]).toBe(first);
    });
    it("rejects slide or image options on templates that cannot display them", () => {
        const config = initialBillboard("First");
        expect(parseBillboard({ ...config, slides: ["First"] })).toBeUndefined();
        expect(parseBillboard({ ...config, image: "https://example.com/a.png" })).toBeUndefined();
    });
});
