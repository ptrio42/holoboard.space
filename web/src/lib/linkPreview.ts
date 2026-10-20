import { boardReference } from "./boardComposer";
import { nip19 } from "@nostr-dev-kit/ndk";
import { RELAY_HTTP } from "../config";
import { parseContent } from "../utils/textProcessing/parseContent";
import { quoteReference } from "./noteAttachments";
import { parseNoteReference } from "./nostr";

export interface LinkPreview { url: string; title: string; description?: string; imageUrl?: string }

export function firstPreviewLink(text: string, strictReferences = false): string | null {
    for (const token of parseContent(text)) {
        if (token.kind !== "link" || (strictReferences ? !!boardReference(token.href) : !!quoteReference(token.href) || !!parseNoteReference(token.href))) continue;
        try {
            const url = new URL(token.href);
            if (/\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico|tiff?|mp4|webm|mov|m4v)$/i.test(url.pathname)) continue;
            const reference = url.pathname.match(/(?:npub1|nprofile1|note1|nevent1|naddr1)[023456789acdefghjklmnpqrstuvwxyz]+/i)?.[0];
            if (reference && !strictReferences) {
                try { nip19.decode(reference.toLowerCase()); continue; } catch { /* An invalid reference can still be an ordinary page link. */ }
            }
            if (!url.username && !url.password) return url.href;
        } catch { /* Malformed URLs remain ordinary text links. */ }
    }
    return null;
}

const cache = new Map<string, { expires: number; value: Promise<LinkPreview | null>; resolved?: LinkPreview | null }>();
export function cachedLinkPreview(url: string): LinkPreview | null {
    const existing = cache.get(url);
    return existing && existing.expires > Date.now() ? existing.resolved ?? null : null;
}
export function fetchLinkPreview(url: string): Promise<LinkPreview | null> {
    const existing = cache.get(url);
    if (existing && existing.expires > Date.now()) return existing.value;
    if (cache.size >= 512) cache.delete(cache.keys().next().value!);
    const entry: { expires: number; value: Promise<LinkPreview | null>; resolved?: LinkPreview | null } = { expires: Date.now() + 3600000, value: Promise.resolve<LinkPreview | null>(null) };
    entry.value = fetch(`${RELAY_HTTP}/api/link-preview?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(6000) })
        .then(async (response): Promise<LinkPreview | null> => {
            if (!response.ok) return null;
            const data: unknown = await response.json();
            if (typeof data !== "object" || data === null || !("title" in data) || typeof data.title !== "string" || !("url" in data) || typeof data.url !== "string") return null;
            const target = new URL(data.url);
            if (!/^https?:$/.test(target.protocol) || target.username || target.password) return null;
            let imageUrl: string | undefined;
            if ("image_url" in data && typeof data.image_url === "string") {
                try {
                    const image = new URL(data.image_url);
                    if (/^https?:$/.test(image.protocol) && !image.username && !image.password && (globalThis.location?.protocol !== "https:" || image.protocol === "https:")) imageUrl = image.href;
                } catch { /* Invalid image metadata does not remove the text card. */ }
            }
            return { url: target.href, title: data.title, description: "description" in data && typeof data.description === "string" ? data.description : undefined, imageUrl };
        }).catch(() => null).then((result) => {
            entry.resolved = result;
            entry.expires = Date.now() + (result ? 3600000 : 60000);
            return result;
        });
    cache.set(url, entry);
    return entry.value;
}
