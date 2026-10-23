import { nip19 } from "nostr-tools";
import { parseContent } from "./parseContent";
import { quoteReference } from "./noteAttachments";
import { parseNoteReference, parseWholeNoteReference as boardReference } from "./nostr";

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
