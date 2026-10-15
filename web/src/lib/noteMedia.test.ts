import { expect, it } from "vitest";
import { mediaTokens, noteMediaItems, videoPoster } from "./noteMedia";

it("uses only a safe preview matched to the exact signed media source", () => {
    const src = "https://media.example/clip.mp4";
    expect(videoPoster([["imeta", `url ${src}`, "thumb https://media.example/thumb.jpg", "image https://media.example/full.jpg"]], src)).toBe("https://media.example/full.jpg");
    expect(videoPoster([["imeta", "url https://other.example/clip.mp4", "image https://media.example/wrong.jpg"]], src)).toBeUndefined();
    for (const image of ["javascript:alert(1)", "data:image/png;base64,abcd", "https://user:secret@example.com/image.jpg", "invalid"]) {
        expect(videoPoster([["imeta", `url ${src}`, `image ${image}`]], src)).toBeUndefined();
    }
    expect(videoPoster([["imeta", `url ${src}`, "image invalid", "thumb https://media.example/thumb.jpg"]], src)).toBe("https://media.example/thumb.jpg");
});

it("retains mixed source order and exact signed metadata without duplicating URLs", () => {
    const first = "https://media.example/movie.mp4?sig=one#t=2";
    const second = "https://media.example/image.png";
    const third = "https://media.example/extensionless?sig=two";
    const tags = [["imeta", `url ${third}`, "m image/webp", "dim 900x1600", "alt A complete portrait"]];
    const items = noteMediaItems(mediaTokens(`${first}\n${second}\n${third}\n${first}`, tags), tags);
    expect(items.map(item => [item.kind, item.src])).toEqual([["video", first], ["image", second], ["image", third]]);
    expect(items[2]).toMatchObject({ width: 900, height: 1600, alt: "A complete portrait" });
    expect(noteMediaItems(mediaTokens(third + "&changed=1", tags), tags)).toEqual([]);
});

it("ignores unsafe sources and invalid dimensions while preserving ordinary links", () => {
    const src = "https://media.example/photo.png";
    for (const dim of ["0x100", "100x0", "-1x10", "100000000x2", "NaNx20", "1.2x20", "2x100000"]) {
        const tags = [["imeta", `url ${src}`, `dim ${dim}`]];
        expect(noteMediaItems(mediaTokens(src, tags), tags)[0].width).toBeUndefined();
    }
    const unsafe = "https://user:secret@media.example/photo.png";
    expect(noteMediaItems(mediaTokens(unsafe))).toEqual([]);
    expect(mediaTokens(unsafe)[0]).toEqual({ kind: "link", href: unsafe });
});
