import { nip19 } from "nostr-tools";
import { eventPointer } from "./nostrPointers";

/** A note the user wants to promote, resolved down to a plain hex event id. */
export interface NoteReference {
    id: string;
    /** Relay hints carried by an nevent, if there were any. */
    relays: string[];
    /** Author carried by an nevent, if there was one. */
    author?: string;
}

const HEX64 = /^[0-9a-f]{64}$/i;
const BECH32_NOTE = /(?:nostr:)?((?:note1|nevent1)[023456789acdefghjklmnpqrstuvwxyz]+)/i;

/**
 * Pulls an event id out of whatever the user pasted: raw hex, note1, nevent1,
 * a `nostr:` URI, or a client URL with one of those in the path. Returns null
 * when nothing in the string looks like a note.
 */
export function parseNoteReference(input: string): NoteReference | null {
    const text = input.trim();
    if (!text) return null;

    if (HEX64.test(text)) {
        return { id: text.toLowerCase(), relays: [] };
    }

    const match = BECH32_NOTE.exec(text);
    if (!match) return null;

    try {
        const decoded = nip19.decode(match[1].toLowerCase());
        if (decoded.type === "note") {
            return { id: decoded.data, relays: [] };
        }
        if (decoded.type === "nevent") {
            return {
                id: decoded.data.id,
                relays: decoded.data.relays ?? [],
                author: decoded.data.author,
            };
        }
    } catch {
        return null;
    }
    return null;
}

/** The canonical `nostr:nevent1...` form the relay looks for in a mention. */
export function toNeventUri(ref: NoteReference): string {
    const nevent = eventPointer(ref.id, ref.author, ref.relays.slice(0, 3));
    return `nostr:${nevent}`;
}

export function toNpub(pubkey: string): string {
    try {
        return nip19.npubEncode(pubkey);
    } catch {
        return pubkey;
    }
}

/** Accept an npub, nprofile or bare hex public key and normalize it to hex. */
export function parsePubkey(input: string): string | null {
    const value = input.trim();
    if (HEX64.test(value)) return value.toLowerCase();
    try {
        const decoded = nip19.decode(value.replace(/^nostr:/i, ""));
        return decoded.type === "npub" ? decoded.data : decoded.type === "nprofile" ? decoded.data.pubkey : null;
    } catch {
        return null;
    }
}

/** npub1abcd...wxyz, for when a profile has no name to show. */
export function shortNpub(pubkey: string): string {
    const npub = toNpub(pubkey);
    return `${npub.slice(0, 10)}...${npub.slice(-4)}`;
}
