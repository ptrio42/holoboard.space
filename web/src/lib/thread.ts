import { nip19, type Event } from "nostr-tools";
import { eventPointer, pointerRelays } from "./nostrPointers";

export interface ThreadReference { type: "event" | "address" | "external"; value: string; relays: string[]; author?: string }
export interface ThreadContext { root?: ThreadReference; parent?: ThreadReference }
export function threadReference(tag?: string[], authorIndex = 4): ThreadReference | undefined {
    if (!tag?.[1]) return;
    const type = tag[0].toLowerCase();
    if (type === "e" && /^[0-9a-f]{64}$/i.test(tag[1])) return { type: "event", value: tag[1].toLowerCase(), relays: tag[2] ? [tag[2]] : [], author: /^[0-9a-f]{64}$/i.test(tag[authorIndex] ?? "") ? tag[authorIndex] : undefined };
    if (type === "a" && /^\d+:[0-9a-f]{64}:/i.test(tag[1])) return { type: "address", value: tag[1], relays: tag[2] ? [tag[2]] : [] };
    if (type === "i" && /^https?:\/\//i.test(tag[1])) return { type: "external", value: tag[1], relays: [] };
}
export function threadContext(event: Pick<Event, "kind" | "tags">): ThreadContext {
    if (event.kind === 1111) return {
        root: threadReference(event.tags.find((tag) => ["E", "A", "I"].includes(tag[0])), 3),
        parent: threadReference(event.tags.find((tag) => ["e", "a", "i"].includes(tag[0])), 3),
    };
    if (event.kind !== 1) return {};
    const tags = event.tags.filter((tag) => tag[0] === "e");
    const legacy = tags.filter((tag) => !tag[3]);
    return {
        root: threadReference(tags.find((tag) => tag[3] === "root") ?? legacy[0]),
        parent: threadReference(tags.find((tag) => tag[3] === "reply") ?? tags.find((tag) => tag[3] === "root") ?? legacy.at(-1)),
    };
}
export function threadHref(reference: ThreadReference): string {
    if (reference.type === "external") return reference.value;
    if (reference.type === "event") return `https://njump.me/${eventPointer(reference.value, reference.author, reference.relays)}`;
    const [kind, pubkey, ...identifier] = reference.value.split(":");
    return `https://njump.me/${nip19.naddrEncode({ kind: Number(kind), pubkey, identifier: identifier.join(":"), relays: pointerRelays(reference.relays) })}`;
}
