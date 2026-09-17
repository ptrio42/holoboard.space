import { describe, expect, it } from "vitest";
import { noteTextSelection, pastedNoteText, selectedNoteText } from "./noteText";
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
    it("restores source line breaks in pasted multi-line fragments", () => {
        const content = "Before\r\nFirst\r\nSecond\r\nAfter";
        expect(pastedNoteText(content, "First\nSecond")).toBe("First\r\nSecond");
        expect(pastedNoteText(content, "Invented\ntext")).toBe("Invented\ntext");
    });
    it("restores the occurrence with the exact original line breaks", () => {
        const content = "A\r\nB, A\nB";
        expect(noteTextSelection(content, "A\nB")).toEqual([5, 8]);
        expect(noteTextSelection(content, "unrelated")).toBeUndefined();
    });
});
