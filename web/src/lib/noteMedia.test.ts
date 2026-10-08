import { expect, it } from "vitest";
import { videoPoster } from "./noteMedia";

it("uses only a safe preview matched to the exact signed media source", () => {
    const src = "https://media.example/clip.mp4";
    expect(videoPoster([["imeta", `url ${src}`, "thumb https://media.example/thumb.jpg", "image https://media.example/full.jpg"]], src)).toBe("https://media.example/full.jpg");
    expect(videoPoster([["imeta", "url https://other.example/clip.mp4", "image https://media.example/wrong.jpg"]], src)).toBeUndefined();
    for (const image of ["javascript:alert(1)", "data:image/png;base64,abcd", "https://user:secret@example.com/image.jpg", "invalid"]) {
        expect(videoPoster([["imeta", `url ${src}`, `image ${image}`]], src)).toBeUndefined();
    }
    expect(videoPoster([["imeta", `url ${src}`, "image invalid", "thumb https://media.example/thumb.jpg"]], src)).toBe("https://media.example/thumb.jpg");
});
