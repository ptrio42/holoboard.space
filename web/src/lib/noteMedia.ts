/** NIP-92 matches inline metadata by exact source URL; NIP-94 defines image and thumb. */
export function videoPoster(tags: string[][] = [], src: string): string | undefined {
    for (const tag of tags) {
        if (tag[0] !== "imeta" || !tag.includes(`url ${src}`)) continue;
        for (const field of ["image", "thumb"]) for (const value of tag.slice(1)) {
            if (!value.startsWith(`${field} `)) continue;
            try {
                const url = new URL(value.slice(field.length + 1));
                if (/^https?:$/.test(url.protocol) && !url.username && !url.password &&
                    (globalThis.location?.protocol !== "https:" || url.protocol === "https:")) return url.href;
            } catch { /* Invalid metadata leaves the browser's ordinary video preview intact. */ }
        }
    }
    return undefined;
}
