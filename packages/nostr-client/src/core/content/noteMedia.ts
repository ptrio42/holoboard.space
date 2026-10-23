import { parseContent, type ContentToken } from "./parseContent";

export interface NoteMediaItem {
    kind: "image" | "video";
    src: string;
    alt?: string;
    poster?: string;
    width?: number;
    height?: number;
}

export function safeMediaSource(src: string): boolean {
    if (src.length > 2048) return false;
    try {
        const url = new URL(src);
        return /^https?:$/.test(url.protocol) && !url.username && !url.password &&
            (globalThis.location?.protocol !== "https:" || url.protocol === "https:");
    } catch { return false; }
}

function metadata(tags: string[][], src: string): Map<string, string> {
    const result = new Map<string, string>();
    for (const tag of tags) {
        if (tag[0] !== "imeta" || !tag.includes(`url ${src}`)) continue;
        for (const value of tag.slice(1)) {
            const space = value.indexOf(" ");
            if (space > 0 && !result.has(value.slice(0, space))) result.set(value.slice(0, space), value.slice(space + 1));
        }
    }
    return result;
}

/** Match signed NIP-92 metadata by the exact URL, including query and fragment. */
export function mediaTokens(text: string, tags: string[][] = []): ContentToken[] {
    return parseContent(text).map(token => {
        if (token.kind !== "link" && token.kind !== "image" && token.kind !== "video") return token;
        const src = token.kind === "link" ? token.href : token.src;
        if (!safeMediaSource(src)) return { kind: "link", href: src };
        if (token.kind !== "link") return token;
        const mime = metadata(tags, src).get("m") ?? "";
        if (/^image\/[a-z0-9.+-]+$/i.test(mime)) return { kind: "image", src };
        if (/^video\/[a-z0-9.+-]+$/i.test(mime)) return { kind: "video", src };
        return token;
    });
}

export function mediaItemsFromSources(sources: readonly Pick<NoteMediaItem, "kind" | "src">[], tags: string[][] = []): NoteMediaItem[] {
    const seen = new Set<string>();
    return sources.flatMap(source => {
        if (seen.has(source.src) || !safeMediaSource(source.src)) return [];
        seen.add(source.src);
        const meta = metadata(tags, source.src);
        const dimensions = /^(\d+)x(\d+)$/.exec(meta.get("dim") ?? "");
        const width = Number(dimensions?.[1]), height = Number(dimensions?.[2]);
        const valid = width > 0 && height > 0 && width <= 100000 && height <= 100000 && width / height >= .01 && width / height <= 100;
        return [{ ...source, ...(valid ? { width, height } : {}), alt: meta.get("alt")?.slice(0, 512),
            ...(source.kind === "video" ? { poster: videoPoster(tags, source.src) } : {}) }];
    });
}

export function noteMediaItems(tokens: readonly ContentToken[], tags: string[][] = []): NoteMediaItem[] {
    return mediaItemsFromSources(tokens.flatMap(token => token.kind === "image" || token.kind === "video" ? [{ kind: token.kind, src: token.src }] : []), tags);
}

/** NIP-94 image and thumb fields can supply a video poster. */
export function videoPoster(tags: string[][] = [], src: string): string | undefined {
    const meta = metadata(tags, src);
    for (const field of ["image", "thumb"]) {
        const poster = meta.get(field);
        if (poster && safeMediaSource(poster)) return poster;
    }
    return undefined;
}
