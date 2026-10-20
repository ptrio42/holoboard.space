import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from "nostr-tools/pure";
import { nsecEncode } from "nostr-tools/nip19";
import { parseNoteReference } from "./nostr";
import { eventPointer } from "./nostrPointers";
import { verifiedNostrEvent } from "./verifyNostrEvent";

export const ANONYMOUS_NAMESPACE = "space.holoboard.attribution";
export const anonymousTags = () => [["L", ANONYMOUS_NAMESPACE], ["l", "anonymous", ANONYMOUS_NAMESPACE]];
export const isAnonymousPost = (event: { tags: string[][] }) =>
    event.tags.some(tag => tag[0] === "L" && tag[1] === ANONYMOUS_NAMESPACE) &&
    event.tags.some(tag => tag[0] === "l" && tag[1] === "anonymous" && tag[2] === ANONYMOUS_NAMESPACE);

/** Whole-input recognition is deliberately narrower than legacy API parsing. */
export function boardReference(input: string, allowHex = true) {
    let value = input.trim();
    if (/^https?:/i.test(value)) {
        try {
            const url = new URL(value);
            if (url.hostname !== "njump.me" || url.username || url.password || url.port || url.search || url.hash || !/^\/[a-z0-9]+\/?$/i.test(url.pathname)) return null;
            value = url.pathname.replace(/^\/|\/$/g, "");
        } catch { return null; }
    }
    if (!/^(?:nostr:)?(?:note1|nevent1)[a-z0-9]+$/i.test(value) && !(allowHex && /^[a-f0-9]{64}$/i.test(value))) return null;
    return parseNoteReference(value);
}

export function boardReferences(text: string) {
    const matches: { start: number; end: number; reference: NonNullable<ReturnType<typeof boardReference>> }[] = [];
    for (const match of text.matchAll(/https?:\/\/[^\s<>]+|(?<![a-z0-9])(?:nostr:)?(?:note1|nevent1)[a-z0-9]+/gi)) {
        const value = match[0].replace(/[.,;!?)}\]]+$/, "");
        const reference = boardReference(value, false);
        if (reference) matches.push({ start: match.index!, end: match.index! + value.length, reference });
    }
    return matches;
}

export function classifyBoardInput(text: string, interpretation: "auto" | "quote" = "auto") {
    const reference = boardReference(text);
    return reference && interpretation === "auto" ? { mode: "original" as const, reference } : { mode: "post" as const, reference: null };
}

/** Canonicalize only the signing payload. Never rewrite the editor or cursor. */
export async function boardPostTemplate(text: string, resolve: (reference: string) => Promise<Event>, anonymous: boolean, quotedHex?: string): Promise<EventTemplate> {
    const matches = boardReferences(text);
    if (quotedHex && boardReference(text)?.id === quotedHex && matches.length === 0) {
        matches.push({ start: 0, end: text.length, reference: boardReference(text)! });
    }
    const unique = [...new Map(matches.map(match => [match.reference.id, match.reference])).values()];
    if (unique.length > 32) throw new Error("Use at most 32 quoted posts.");
    const sources = new Map<string, Event>();
    // Keep source reads bounded, including when many references were pasted.
    for (const reference of unique) {
        const event = verifiedNostrEvent(await resolve(eventPointer(reference.id, reference.author, reference.relays)));
        if (!event || event.id !== reference.id) throw new Error("Could not verify a quoted post. Retry or remove its reference.");
        sources.set(event.id, event);
    }
    let content = "", cursor = 0;
    for (const match of matches) {
        const source = sources.get(match.reference.id)!;
        content += text.slice(cursor, match.start) + `nostr:${eventPointer(source.id, source.pubkey, match.reference.relays)}`;
        cursor = match.end;
    }
    content += text.slice(cursor);
    if (!content.trim() || new TextEncoder().encode(content).length > 16384) throw new Error("Write a post within 16 KiB, including its references.");
    const tags = unique.map(ref => ["q", ref.id, ref.relays[0] ?? "", sources.get(ref.id)!.pubkey]);
    if (anonymous) tags.push(...anonymousTags());
    return { kind: 1, created_at: Math.floor(Date.now() / 1000), content, tags };
}

/** Each guest post owns one in-memory key. Persist only its signed event. */
export function createGuestAuthor() {
    const key = generateSecretKey();
    return { pubkey: getPublicKey(key), sign: (template: EventTemplate) => finalizeEvent(template, key), export: () => nsecEncode(key), destroy: () => key.fill(0) };
}
