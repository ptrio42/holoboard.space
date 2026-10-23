import { eventPointer, profilePointer } from "./nostrPointers";

export { parseNoteReference, toNeventUri, toNpub, parsePubkey, shortNpub } from '@ptrio42/nostr-client/core';
export type { NoteReference } from '@ptrio42/nostr-client/core';

export function njumpUrl(pubkeyOrId: string, kind: "npub" | "note" = "npub", hints: string[] = [], author?: string): string {
    try {
        return `https://njump.me/${kind === "npub" ? profilePointer(pubkeyOrId, hints) : eventPointer(pubkeyOrId, author, hints)}`;
    } catch {
        return `https://njump.me/${pubkeyOrId}`;
    }
}

/** 21 -> "21", 2100 -> "2.1k", 21000000 -> "21M". */
export function formatSats(sats: number): string {
    if (sats < 1_000) return String(sats);
    if (sats < 1_000_000) {
        const k = sats / 1_000;
        return `${k % 1 === 0 ? k : k.toFixed(1)}k`;
    }
    const m = sats / 1_000_000;
    return `${m % 1 === 0 ? m : m.toFixed(1)}M`;
}

/**
 * A stable colour per pubkey, used for avatar fallbacks so a face-less author
 * is still recognisable between rows.
 */
export function pubkeyHue(pubkey: string): number {
    return parseInt(pubkey.slice(0, 4) || "0", 16) % 360;
}
