import { afterEach, describe, expect, it, vi } from "vitest";
import { nip19 } from "@nostr-dev-kit/ndk";
import { fetchLinkPreview, firstPreviewLink } from "./linkPreview";

afterEach(() => vi.unstubAllGlobals());
describe("ordinary note link previews", () => {
    it("chooses the first page link after media and Nostr references", () => {
        const note = nip19.noteEncode("a".repeat(64));
        const profile = nip19.npubEncode("b".repeat(64));
        expect(firstPreviewLink(`https://example.com/a.png https://example.com/a.mp4 nostr:${note} https://njump.me/${note} https://njump.me/${profile} https://example.com/first. https://example.com/second`)).toBe("https://example.com/first");
        expect(firstPreviewLink(`nostr:${note} https://example.com/a.jpg`)).toBeNull();
        expect(firstPreviewLink("https://example.com/a.png#image https://example.com/a.mp4?download=1#video https://example.com/page")).toBe("https://example.com/page");
        expect(firstPreviewLink("https://user:secret@example.com/private https://example.com/public")).toBe("https://example.com/public");
    });
    it("shares requests and drops invalid image metadata without removing the text card", async () => {
        const fetch = vi.fn(async () => new Response(JSON.stringify({ url: "https://example.com/page", title: "A title", image_url: "invalid" })));
        vi.stubGlobal("fetch", fetch);
        const url = "https://example.com/unit-shared";
        const [first, second] = await Promise.all([fetchLinkPreview(url), fetchLinkPreview(url)]);
        expect(first).toEqual({ url: "https://example.com/page", title: "A title", description: undefined, imageUrl: undefined });
        expect(second).toEqual(first);
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    it("keeps errors and unsafe metadata out of cards", async () => {
        const fetch = vi.fn()
            .mockResolvedValueOnce(new Response("unavailable", { status: 502 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ url: "javascript:alert(1)", title: "Unsafe" })))
            .mockRejectedValueOnce(new Error("Offline"));
        vi.stubGlobal("fetch", fetch);
        for (const url of ["failed", "unsafe", "offline"]) expect(await fetchLinkPreview(`https://example.com/unit-${url}`)).toBeNull();
    });
});
