import { nip19, type NDKFilter } from "@nostr-dev-kit/ndk";
import { parseContent, type ContentToken } from "../utils/textProcessing/parseContent";
import { parseNoteReference } from "./nostr";

export interface NoteQuoteReference {
    key: string;
    bech32: string;
    filter: NDKFilter;
    relays: string[];
}

export function quoteReference(value: string): NoteQuoteReference | null {
    try {
        const reference = parseNoteReference(value);
        const bech32 = reference ? nip19.neventEncode(reference) : value.replace(/^nostr:/i, "").toLowerCase();
        const decoded = nip19.decode(bech32);
        if (decoded.type === "note") return { key: decoded.data, bech32, filter: { ids: [decoded.data] }, relays: [] };
        if (decoded.type === "nevent") return { key: decoded.data.id, bech32,
            filter: { ids: [decoded.data.id] }, relays: decoded.data.relays ?? [] };
        if (decoded.type === "naddr") return { key: `${decoded.data.kind}:${decoded.data.pubkey}:${decoded.data.identifier}`, bech32,
            filter: { kinds: [decoded.data.kind], authors: [decoded.data.pubkey], "#d": [decoded.data.identifier] },
            relays: decoded.data.relays ?? [] };
    } catch {
        // Invalid references remain ordinary text or links.
    }
    return null;
}

/** Advertising destinations are derived from signed content, never invented by the editor. */
export function noteAttachments(content: string, tags: string[][] = [], ownId?: string) {
    const links = new Set<string>();
    const quotes = new Map<string, NoteQuoteReference>();
    const addQuote = (reference: NoteQuoteReference | null) => {
        if (!reference || reference.key === ownId) return;
        const existing = quotes.get(reference.key);
        if (existing) existing.relays = [...new Set([...existing.relays, ...reference.relays])];
        else quotes.set(reference.key, reference);
    };
    for (const token of parseContent(content)) {
        if (token.kind === "link") {
            const quote = quoteReference(token.href);
            if (quote) addQuote(quote);
            else links.add(token.href);
        } else if (token.kind === "mention") addQuote(quoteReference(token.bech32));
    }
    for (const tag of tags) {
        if (tag[0] !== "q" || !tag[1]) continue;
        if (/^[0-9a-f]{64}$/i.test(tag[1])) {
            addQuote(quoteReference(nip19.neventEncode({ id: tag[1].toLowerCase(), relays: tag[2] ? [tag[2]] : [] })));
        } else addQuote(quoteReference(tag[1]));
    }
    return { links: [...links], quotes: [...quotes.values()] };
}

export function linkLabel(href: string): string {
    try {
        const url = new URL(href);
        return `${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search}`;
    } catch { return href; }
}

/** Keep references intact so the compact renderer can still turn them into links. */
export function quotePreviewContent(content: string, limit = 220): string {
    const output: string[] = [];
    let used = 0;
    let truncated = false;
    const source = (token: ContentToken) => {
        if (token.kind === "text") return token.value;
        if (token.kind === "mention") return `nostr:${token.bech32}`;
        if (token.kind === "link") return token.href;
        return token.kind === "image" ? " [Image] " : " [Video] ";
    };
    const displayLength = (token: ContentToken) => {
        if (token.kind === "link") return Array.from(linkLabel(token.href)).length;
        if (token.kind === "mention") return Math.min(16, Array.from(token.bech32).length);
        return Array.from(source(token)).length;
    };

    for (const token of parseContent(content)) {
        const length = displayLength(token);
        if (used + length <= limit) {
            output.push(source(token));
            used += length;
            continue;
        }
        const remaining = limit - used;
        if (token.kind === "text" && remaining > 0) output.push(Array.from(token.value).slice(0, remaining).join(""));
        else if (remaining >= Math.min(length, 16)) output.push(source(token));
        truncated = true;
        break;
    }
    const preview = output.join("").replace(/\s+/g, " ").trim();
    return `${preview || "Open quoted note"}${truncated ? "…" : ""}`;
}
