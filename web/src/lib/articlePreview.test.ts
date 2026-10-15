import { describe, expect, it, vi } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { articlePreview } from "./articlePreview";

const readable = (body: ReturnType<typeof articlePreview>) => body.words.map(token =>
    token.kind === "text" || token.kind === "formatted" ? token.value : token.kind === "article-link" ? token.label : "").join("");

describe("article previews", () => {
    it("keeps Markdown text, link labels and code while separating reference media", () => {
        const body = articlePreview("### Small code\n\n**A bold idea** and *another*. [Explore][site]\n\n![Image][photo]\n\n![Video](https://example.com/play.mp4)\n\n1. First\n2. Second\n\n```sh\ncurl https://example.com/install.sh\n```\n\n[site]: https://example.com/project\n[photo]: https://example.com/photo.png");
        expect(readable(body)).toContain("Small code\n\nA bold idea and another. Explore");
        expect(readable(body)).toContain("1. First\n2. Second");
        expect(readable(body)).toContain("curl https://example.com/install.sh");
        expect(body.images).toEqual(["https://example.com/photo.png"]);
        expect(body.videos).toEqual(["https://example.com/play.mp4"]);
        expect(body.media).toEqual([
            { kind: "image", src: "https://example.com/photo.png" },
            { kind: "video", src: "https://example.com/play.mp4" },
        ]);
        expect(body.link).toBe("https://example.com/project");
        expect(body.words).toContainEqual({ kind: "formatted", value: "A bold idea", formats: ["strong"] });
    });

    it("does not turn HTML, code or unsafe destinations into active resources", () => {
        const body = articlePreview('<script>https://example.com/attack.png</script>\n\n`https://example.com/code.png`\n\n```\nhttps://example.com/code.mp4\n```\n\n[unsafe](javascript:alert%281%29) ![unsafe](data:image/png;base64,AAAA) [private](https://name:password@example.com/)');
        expect(body.images).toEqual([]); expect(body.videos).toEqual([]); expect(body.link).toBeNull();
        expect(body.words.filter(token => token.kind === "link" || token.kind === "article-link")).toEqual([]);
        expect(readable(body)).toContain("<script>https://example.com/attack.png</script>");
        expect(readable(body)).toContain("https://example.com/code.mp4");
        expect(readable(body)).toContain("unsafe");
    });

    it("preserves Nostr mentions and explicit reference destinations", () => {
        const profile = npubEncode("ab".repeat(32));
        const body = articlePreview(`By nostr:${profile}\n\n[Author](nostr:${profile})\n\n[**Project**](https://example.com)`);
        expect(body.words.filter(token => token.kind === "mention")).toEqual([
            { kind: "mention", bech32: profile }, { kind: "mention", bech32: profile },
        ]);
        expect(body.words).toContainEqual({ kind: "article-link", href: "https://example.com", label: "Project" });
    });
});

it("recognizes extensionless article media only with exact signed MIME metadata", () => {
    const src = "https://media.example/file?sig=one";
    const body = articlePreview(`[Clip](${src})\n\n![Portrait](https://media.example/portrait.png)`, [["imeta", `url ${src}`, "m video/mp4"]]);
    expect(body.media).toEqual([{ kind: "video", src }, { kind: "image", src: "https://media.example/portrait.png" }]);
    expect(body.link).toBeNull();
});

it("keeps ordinary HTTP and long article links while blocking mixed-content media", () => {
    vi.stubGlobal("location", { protocol: "https:" });
    try {
        const href = "http://example.com/story";
        const body = articlePreview(`[Read](${href})\n\n![Photo](http://media.example/photo.png)`);
        expect(body.words).toContainEqual({ kind: "article-link", href, label: "Read" });
        expect(body.link).toBe(href);
        expect(body.media).toEqual([]);
        const long = "https://example.com/" + "x".repeat(2050);
        expect(articlePreview(`[Read](${long})`).words).toContainEqual({ kind: "article-link", href: long, label: "Read" });
    } finally { vi.unstubAllGlobals(); }
});
