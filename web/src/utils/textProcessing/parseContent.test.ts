import { describe, expect, it } from "vitest";
import { parseContent, type ContentToken } from "./parseContent";

const kinds = (tokens: ContentToken[]) => tokens.map((t) => t.kind);
const text = (tokens: ContentToken[]) =>
    tokens.filter((t) => t.kind === "text").map((t) => (t as { value: string }).value).join("");

describe("parseContent", () => {
    it("keeps plain text whole", () => {
        const tokens = parseContent("just some words\nand a second line");
        expect(kinds(tokens)).toEqual(["text"]);
        expect(text(tokens)).toBe("just some words\nand a second line");
    });

    it("never loses a character of the original", () => {
        const source = "look https://example.com/a.png at nostr:npub1abcdefghijklmnopqrstuvwxyz end.";
        const tokens = parseContent(source);
        const rebuilt = tokens
            .map((t) =>
                t.kind === "text"
                    ? t.value
                    : t.kind === "mention"
                      ? `nostr:${t.bech32}`
                      : "src" in t
                        ? t.src
                        : t.href,
            )
            .join("");
        expect(rebuilt).toBe(source);
    });

    it("recognises the image extensions", () => {
        for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "avif"]) {
            const tokens = parseContent(`https://host/pic.${ext}`);
            expect(kinds(tokens)).toEqual(["image"]);
        }
    });

    // The point of the change: a video link used to render as a bare link.
    it("recognises the video extensions", () => {
        for (const ext of ["mp4", "webm", "mov", "m4v"]) {
            const tokens = parseContent(`https://host/clip.${ext}`);
            expect(kinds(tokens)).toEqual(["video"]);
        }
    });

    it("treats an unknown extension as a link", () => {
        expect(kinds(parseContent("https://host/thing.pdf"))).toEqual(["link"]);
        expect(kinds(parseContent("https://www.youtube.com/watch?v=abc"))).toEqual(["link"]);
    });

    it("survives a query string after the extension", () => {
        expect(kinds(parseContent("https://host/clip.mp4?token=x"))).toEqual(["video"]);
        expect(kinds(parseContent("https://host/pic.png?w=100"))).toEqual(["image"]);
    });

    // A URL ending a sentence used to swallow the full stop, which broke both
    // the link and the extension test.
    it("leaves sentence punctuation out of the url", () => {
        const tokens = parseContent("see https://host/pic.png. next");
        expect(kinds(tokens)).toEqual(["text", "image", "text"]);
        expect((tokens[1] as { src: string }).src).toBe("https://host/pic.png");
        expect(text(tokens)).toBe("see . next");
    });

    it("keeps a bracket the url opened", () => {
        const tokens = parseContent("https://en.wikipedia.org/wiki/Foo_(bar)");
        expect(kinds(tokens)).toEqual(["link"]);
        expect((tokens[0] as { href: string }).href).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    });

    it("finds nostr references with and without the prefix", () => {
        for (const prefix of ["npub1", "nprofile1", "note1", "nevent1", "naddr1"]) {
            const bech32 = `${prefix}${"a".repeat(30)}`;
            expect(kinds(parseContent(`nostr:${bech32}`))).toEqual(["mention"]);
            expect(kinds(parseContent(bech32))).toEqual(["mention"]);
        }
    });

    it("does not treat markup as markup", () => {
        const source = '<img src=x onerror="alert(1)"> & <script>';
        const tokens = parseContent(source);
        expect(kinds(tokens)).toEqual(["text"]);
        expect(text(tokens)).toBe(source);
    });

    it("only ever matches http and https", () => {
        expect(kinds(parseContent("javascript:alert(1)"))).toEqual(["text"]);
        expect(kinds(parseContent("data:text/html;base64,PHNjcmlwdD4="))).toEqual(["text"]);
        expect(kinds(parseContent("ftp://host/file.mp4"))).toEqual(["text"]);
    });

    it("handles several tokens in one note", () => {
        const tokens = parseContent(
            "hi https://host/a.png and https://host/b.mp4 and https://host/c plus note1" + "z".repeat(30),
        );
        expect(kinds(tokens)).toEqual(["text", "image", "text", "video", "text", "link", "text", "mention"]);
    });

    it("copes with an empty string", () => {
        expect(parseContent("")).toEqual([]);
        expect(parseContent()).toEqual([]);
    });
});
