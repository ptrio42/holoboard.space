/** Keep untrusted public text as a bounded, single-line metadata value. */
export function metadataExcerpt(text: string | undefined, limit: number): string {
    const characters = Array.from((text ?? "").replace(/\s+/gu, " ").trim());
    return characters.length > limit ? characters.slice(0, limit - 3).join("").trimEnd() + "..." : characters.join("");
}
