import { describe, expect, it } from "vitest";
import { noteTextSelection, selectedNoteText } from "./noteText";
import { initialBillboard, validBillboard } from "./billboard";

describe("fragments from textarea selections", () => {
    it("preserves signed CRLF and lone CR line breaks", () => {
        const content = "First\r\nSecond\rThird\nLast";
        const fragment = selectedNoteText(content, 6, 18);
        expect(fragment).toBe("Second\rThird");
        expect(selectedNoteText(content, 0, 23)).toBe(content);
        expect(validBillboard({ ...initialBillboard(content), text: fragment }, content, [])).toBe(true);
    });
    it("uses DOM UTF-16 offsets for emoji following CRLF", () => {
        const content = "A\r\n😀 next";
        expect(selectedNoteText(content, 2, 4)).toBe("😀");
        expect(noteTextSelection(content, "😀")).toEqual([2, 4]);
    });
    it("maps multi-line selection boundaries back to the signed source", () => {
        const content = "Before\r\nFirst\r\nSecond\r\nAfter";
        expect(selectedNoteText(content, 7, 19)).toBe("First\r\nSecond");
        expect(noteTextSelection(content, "First\r\nSecond")).toEqual([7, 19]);
    });
    it("restores the occurrence with the exact original line breaks", () => {
        const content = "A\r\nB, A\nB";
        expect(noteTextSelection(content, "A\nB")).toEqual([5, 8]);
        expect(noteTextSelection(content, "unrelated")).toBeUndefined();
    });
});
