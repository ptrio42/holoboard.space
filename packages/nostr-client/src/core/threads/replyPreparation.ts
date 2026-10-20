import type { Event, EventTemplate } from "nostr-tools";
import { relayCandidates } from "../transport/relayUrl";
import type { ThreadGraph, ThreadNode } from "./threadGraph";
import { normalizeThreadRelations, type RelationTarget } from "./threadRelations";
import { verifiedNostrEvent } from "../events/verifyNostrEvent";
import { attachmentTags, type ComposerAttachment } from "../content/composerMedia";

export interface PreparedReply {
    template: EventTemplate;
    parentId: string;
    root: RelationTarget;
    recipients: string[];
}
export class ReplyContextError extends Error {}
const HEX = /^[0-9a-f]{64}$/i;
function unavailable(): never { throw new ReplyContextError("Reply context is incomplete or conflicting. Load its ancestors before preparing a reply."); }
function address(event: Event) {
    if (event.kind === 0 || event.kind === 3 || event.kind >= 10000 && event.kind < 20000) return `${event.kind}:${event.pubkey}:`;
    if (event.kind >= 30000 && event.kind < 40000) return `${event.kind}:${event.pubkey}:${event.tags.find(tag => tag[0] === "d")?.[1] ?? ""}`;
}
function eventScope(event: Event): RelationTarget {
    const value = address(event);
    return { type: value ? "address" : "event", value: value ?? event.id, exactId: value ? event.id : undefined,
        kind: event.kind, author: event.pubkey, relays: [], hints: [] };
}
function complete(node: ThreadNode) {
    return !["invalid", "conflict", "unresolved", "depth-limit", "budget"].includes(node.rootState) &&
        ["none", "resolved", "external"].includes(node.parentState);
}
/** Graph metadata must come from the verified ingress, as for discussion display.
 * This pure preparation step cannot sign, publish or add paid board membership.
 */
export function prepareReply({ parent: input, graph, content, createdAt, hints = {}, attachments = [], validateMediaUrl, candidates = relayCandidates }: {
    parent: Event; graph: ThreadGraph; content: string; createdAt: number;
    hints?: Readonly<Record<string, readonly string[]>>;
    attachments?: readonly ComposerAttachment[];
    validateMediaUrl?: (value: string) => string;
    candidates?: typeof relayCandidates;
}): PreparedReply {
    if (!content.trim() || new TextEncoder().encode(content).length > 16384) throw new RangeError("A reply needs text of at most 16 KiB.");
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new RangeError("Invalid reply timestamp.");
    if (JSON.stringify(input).length * 3 > 262144) throw new RangeError("Reply parent exceeds the reading limit.");
    const parent = verifiedNostrEvent(input);
    if (!parent) throw new ReplyContextError("The reply parent is not a verified signed event.");
    const node = graph.nodes.get(`event:${parent.id}`);
    if (!node?.event || JSON.stringify(node.event.tags) !== JSON.stringify(parent.tags) || node.event.pubkey !== parent.pubkey || node.event.kind !== parent.kind || node.event.created_at !== parent.created_at) unavailable();
    const hint = (id: string, extra: string[] = []) => candidates([...(hints[id] ?? []).slice(0, 4), ...extra], 1)[0] ?? "";
    let root: RelationTarget;
    let tags: string[][];
    if (parent.kind === 1) {
        let cursor = node;
        const visited = new Set<string>();
        while (true) {
            if (visited.has(cursor.key) || visited.size >= graph.limits.maxDepth || !cursor.event || cursor.event.kind !== 1 || !complete(cursor)) unavailable();
            visited.add(cursor.key);
            if (cursor.parentState === "none") break;
            if (cursor.parentState !== "resolved" || !cursor.parent) unavailable();
            cursor = graph.nodes.get(cursor.parent) ?? unavailable();
        }
        const event = cursor.event!;
        root = { type: "event", value: event.id, kind: 1, author: event.pubkey,
            relays: candidates(node.relations?.root.target?.relays ?? [], 4), hints: [] };
        tags = [["e", event.id, hint(event.id, root.relays), "root", event.pubkey]];
        if (parent.id !== event.id) tags.push(["e", parent.id, hint(parent.id), "reply", parent.pubkey]);
        const recipients = [...new Set([parent.pubkey, event.pubkey, ...parent.tags.filter(tag => tag[0] === "p" && HEX.test(tag[1] ?? "")).map(tag => tag[1].toLowerCase())])].sort();
        if (recipients.length > 64) throw new RangeError("This reply exceeds the 64-recipient limit.");
        tags.push(...recipients.map(pubkey => ["p", pubkey]));
    } else {
        if (parent.kind === 1111) {
            const relation = normalizeThreadRelations(parent);
            if (!complete(node) || relation.root.state !== "valid" || !relation.root.target) unavailable();
            root = { ...relation.root.target, relays: [...relation.root.target.relays], hints: [...relation.root.target.hints] };
        } else root = eventScope(parent);
        const scopeTags = (scope: RelationTarget, uppercase: boolean): string[][] => {
            const ref = uppercase ? { event: "E", address: "A", external: "I" } : { event: "e", address: "a", external: "i" };
            const relay = scope.type === "external" ? "" : hint(scope.exactId ?? scope.value, scope.relays);
            const result = [[ref[scope.type], scope.value, relay]];
            if (scope.type === "event" && scope.author) result[0].push(scope.author);
            if (scope.type === "address" && scope.exactId) result.push([uppercase ? "E" : "e", scope.exactId, relay, scope.author!]);
            if (scope.kind === undefined) unavailable();
            result.push([uppercase ? "K" : "k", String(scope.kind)]);
            if (scope.author) result.push([uppercase ? "P" : "p", scope.author]);
            return result;
        };
        tags = [...scopeTags(root, true), ...scopeTags(eventScope(parent), false)];
        // External identifiers stay opaque. Do not turn arbitrary signed hint
        // values into web requests or substitute an address for an exact ID.
        if (root.type === "external") tags[0] = ["I", root.value];
    }
    tags.push(...attachmentTags(attachments, content, validateMediaUrl));
    const template: EventTemplate = { kind: parent.kind === 1 ? 1 : 1111, created_at: createdAt, content, tags };
    if (JSON.stringify(template).length * 3 > 65536) throw new RangeError("Prepared reply exceeds the 64 KiB event limit.");
    const recipients = [...new Set(tags.filter(tag => ["p", "P"].includes(tag[0])).map(tag => tag[1]))].sort();
    return { template, parentId: parent.id, root, recipients };
}
