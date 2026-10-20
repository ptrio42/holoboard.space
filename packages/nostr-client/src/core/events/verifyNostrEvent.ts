import { verifyEvent, type Event } from "nostr-tools";

/** Strip library verification flags and validate the complete signed object. */
export function verifiedNostrEvent(value: unknown): Event | undefined {
    try {
        if (!value || typeof value !== "object") return;
        const event = value as Event;
        if (!Number.isSafeInteger(event.created_at) || event.created_at < 0 || !Number.isInteger(event.kind) || event.kind < 0 || event.kind > 65535 ||
            typeof event.id !== "string" || !/^[0-9a-f]{64}$/.test(event.id) || typeof event.pubkey !== "string" || !/^[0-9a-f]{64}$/.test(event.pubkey) ||
            typeof event.sig !== "string" || !/^[0-9a-f]{128}$/.test(event.sig) || typeof event.content !== "string" ||
            !Array.isArray(event.tags) || !event.tags.every((tag) => Array.isArray(tag) && tag.every((item) => typeof item === "string"))) return;
        const clean: Event = { id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind,
            tags: event.tags.map((tag) => [...tag]), content: event.content, sig: event.sig };
        return verifyEvent(clean) ? clean : undefined;
    } catch { return; }
}
