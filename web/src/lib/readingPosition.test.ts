import { expect, it } from "vitest";
import { boardPresentation, readingPosition, rememberBoardPresentation } from "./readingPosition";
const id = "a".repeat(64);
const origin = (presentation: number) => ({ id, top: -140, path: "/waiting?view=hot", presentation, expanded: true });
it("accepts bounded reading anchors and ignores malformed or external history state", () => {
    expect(readingPosition({ readingScroll: 540, readingAnchor: { id, top: -140 }, readingOrigin: origin(1), readingAlign: true }))
        .toEqual({ readingScroll: 540, readingAnchor: { id, top: -140 }, readingOrigin: origin(1), readingAlign: true });
    for (const value of [null, false, "malformed", { readingScroll: Infinity, readingAnchor: { id, top: NaN }, readingOrigin: { ...origin(1), path: "https://external.example" } }]) {
        expect(readingPosition(value)).toMatchObject({ readingScroll: 0, readingAnchor: undefined, readingOrigin: undefined });
    }
    for (const path of ["//external.example", "/help", "/waiting?view=invalid", "/expired?external=1"]) expect(readingPosition({ readingOrigin: { ...origin(1), path } }).readingOrigin).toBeUndefined();
    expect(readingPosition({ readingScroll: -10 }).readingScroll).toBe(0);
    expect(readingPosition({ readingScroll: 1e20 }).readingScroll).toBe(10_000_000);
    expect(readingPosition({ readingAnchor: { id: id.toUpperCase(), top: 0 } }).readingAnchor).toBeUndefined();
    expect(readingPosition({ readingAnchor: { id, top: 1_000_001 } }).readingAnchor).toBeUndefined();
});
it("bounds presentation retention by count and bytes without retaining oversized billboard data", () => {
    const first = rememberBoardPresentation({ rank: 1 });
    expect(boardPresentation(origin(first))).toEqual({ rank: 1 });
    for (let i = 0; i < 16; i++) rememberBoardPresentation({ rank: i + 2 });
    expect(boardPresentation(origin(first))).toBeUndefined();
    const oversized = rememberBoardPresentation({ billboard: { template: "image-led", text: "Image", color: "cyan", size: "small", speed: "normal", image: `https://images.example/${"x".repeat(16384)}` } });
    expect(boardPresentation(origin(oversized))).toBeUndefined();
    const billboard = { template: "led" as const, text: "Original", color: "cyan" as const, size: "small" as const, speed: "normal" as const };
    const copy = rememberBoardPresentation({ billboard });
    billboard.text = "Changed";
    expect(boardPresentation(origin(copy))?.billboard?.text).toBe("Original");
});
