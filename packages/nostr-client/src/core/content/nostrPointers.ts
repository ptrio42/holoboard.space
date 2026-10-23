import { neventEncode, nprofileEncode } from "nostr-tools/nip19";
import { relayCandidates } from "../transport/relayUrl";

/** NIP-19 relay TLVs have a one-byte length. Keep pointers small and routable. */
export function pointerRelays(hints: string[] = [], candidates: typeof relayCandidates = relayCandidates): string[] {
    return candidates(hints.slice(0, 16), 16)
        .filter(relay => /^[\x20-\x7e]+$/.test(relay) && relay.length <= 255).slice(0, 4);
}

export function eventPointer(id: string, author?: string, hints: string[] = [], candidates: typeof relayCandidates = relayCandidates): string {
    return neventEncode({ id, author: author && /^[0-9a-f]{64}$/.test(author) ? author : undefined, relays: pointerRelays(hints, candidates) });
}

export function profilePointer(pubkey: string, hints: string[] = [], candidates: typeof relayCandidates = relayCandidates): string {
    return nprofileEncode({ pubkey, relays: pointerRelays(hints, candidates) });
}
