import { nip19 } from "@nostr-dev-kit/ndk";

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
    const nevent = nip19.neventEncode({
        id: ref.id,
        relays: ref.relays.slice(0, 3),
        author: ref.author,
    });
    return `nostr:${nevent}`;
}

export function toNpub(pubkey: string): string {
    try {
        return nip19.npubEncode(pubkey);
    } catch {
        return pubkey;
    }
}

/** npub1abcd...wxyz, for when a profile has no name to show. */
export function shortNpub(pubkey: string): string {
    const npub = toNpub(pubkey);
    return `${npub.slice(0, 10)}...${npub.slice(-4)}`;
}

export function njumpUrl(pubkeyOrId: string, kind: "npub" | "note" = "npub"): string {
    const encoded = kind === "npub" ? toNpub(pubkeyOrId) : safeNoteEncode(pubkeyOrId);
    return `https://njump.me/${encoded}`;
}

function safeNoteEncode(id: string): string {
    try {
        return nip19.noteEncode(id);
    } catch {
        return id;
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
