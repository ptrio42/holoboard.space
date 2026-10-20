import type { Event } from "nostr-tools";

/** Protocol claims only. Relay hints are data, never permission to connect. */
export interface RelationTarget {
    type: "event" | "address" | "external";
    value: string;
    exactId?: string;
    kind?: number | string;
    author?: string;
    relays: string[];
    hints: string[];
}

export type RelationIssue = "invalid-reference" | "multiple-targets" | "missing-reference" |
    "missing-kind" | "invalid-kind" | "kind-conflict" | "missing-author" | "invalid-author" | "author-conflict";

export interface RelationClaim {
    state: "absent" | "valid" | "invalid" | "conflict";
    target?: RelationTarget;
    candidates: RelationTarget[];
    /** Lowercase p tags may also be mentions. Resolve ambiguity against the event. */
    authors: string[];
    issues: RelationIssue[];
}

export interface ThreadRelations {
    protocol: "nip10" | "nip22" | "none";
    provenance: "marked" | "positional" | "nip22" | "none";
    root: RelationClaim;
    parent: RelationClaim;
}

const hex = (value: string | undefined) => value && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : undefined;
const unique = (values: string[]) => [...new Set(values)].sort();
const kindNumber = (value: string) => /^(0|[1-9]\d*)$/.test(value) && Number(value) <= 65535 ? Number(value) : undefined;
export function parseThreadAddress(value: string): { kind: number; pubkey: string; identifier: string } | undefined {
    const match = /^(\d+):([a-f0-9]{64}):([\s\S]*)$/i.exec(value);
    if (!match) return;
    const kind = kindNumber(match[1]);
    if (kind === undefined) return;
    const addressable = kind >= 30000 && kind < 40000;
    if (!addressable && !(kind === 0 || kind === 3 || kind >= 10000 && kind < 20000)) return;
    if (!addressable && match[3] !== "") return;
    return { kind, pubkey: match[2].toLowerCase(), identifier: match[3] };
}

const absent = (): RelationClaim => ({ state: "absent", candidates: [], authors: [], issues: [] });
function claim(candidates: RelationTarget[], issues: RelationIssue[] = [], authors: string[] = []): RelationClaim {
    const grouped = new Map<string, RelationTarget>();
    for (const candidate of candidates) {
        const key = `${candidate.type}:${candidate.value}`;
        const old = grouped.get(key);
        if (old?.author && candidate.author && old.author !== candidate.author) issues.push("author-conflict");
        const author = unique([old?.author, candidate.author].filter((value): value is string => !!value))[0];
        grouped.set(key, { ...candidate, author,
            relays: unique([...(old?.relays ?? []), ...candidate.relays]), hints: unique([...(old?.hints ?? []), ...candidate.hints]) });
    }
    const targets = [...grouped.values()].sort((a, b) => `${a.type}:${a.value}`.localeCompare(`${b.type}:${b.value}`));
    if (targets.length > 1) issues.push("multiple-targets");
    issues = unique(issues) as RelationIssue[];
    const conflict = issues.some((issue) => ["multiple-targets", "kind-conflict", "author-conflict"].includes(issue));
    const state = conflict ? "conflict" : issues.length ? "invalid" : targets.length ? "valid" : "absent";
    return { state, target: state === "valid" ? targets[0] : undefined, candidates: targets, authors: unique(authors), issues };
}

function reference(tag: string[], authorIndex: number): RelationTarget | undefined {
    const value = tag[1];
    if (!value) return;
    if (tag[0].toLowerCase() === "e") {
        const id = hex(value);
        if (id) return { type: "event", value: id, author: hex(tag[authorIndex]), relays: tag[2] ? [tag[2]] : [], hints: [] };
    } else if (tag[0].toLowerCase() === "a") {
        const address = parseThreadAddress(value);
        if (address) return { type: "address", value: `${address.kind}:${address.pubkey}:${address.identifier}`,
            kind: address.kind, author: address.pubkey, relays: tag[2] ? [tag[2]] : [], hints: [] };
    } else if (tag[0].toLowerCase() === "i") {
        return { type: "external", value, relays: [], hints: tag[2] ? [tag[2]] : [] };
    }
}

function noteClaim(tags: string[][]): RelationClaim {
    const issues: RelationIssue[] = [];
    const candidates: RelationTarget[] = [];
    for (const tag of tags) {
        const target = reference(tag, 4);
        if (!target) issues.push("invalid-reference");
        else candidates.push({ ...target, kind: 1 });
        if (tag[4] && !hex(tag[4])) issues.push("invalid-author");
    }
    return claim(candidates, issues);
}

function commentClaim(tags: string[][], root: boolean): RelationClaim {
    const names = root ? ["E", "A", "I"] : ["e", "a", "i"];
    const refs = tags.filter((tag) => names.includes(tag[0]));
    const issues: RelationIssue[] = [];
    if (!refs.length) issues.push("missing-reference");
    const parsed: RelationTarget[] = [];
    for (const tag of refs) {
        const target = reference(tag, 3);
        if (target) parsed.push(target); else issues.push("invalid-reference");
        if (tag[0].toLowerCase() === "e" && tag[3] && !hex(tag[3])) issues.push("invalid-author");
    }
    // Coalesce repeated tags before combining address and exact-version aliases.
    const preliminary = claim(parsed);
    issues.push(...preliminary.issues.filter((issue) => issue !== "multiple-targets"));
    let candidates = preliminary.candidates;
    if (candidates.length === 2 && candidates[0].type === "address" && candidates[1].type === "event") {
        const [address, event] = candidates;
        if (event.author && address.author !== event.author) issues.push("author-conflict");
        candidates = [{ ...address, exactId: event.value, relays: unique([...address.relays, ...event.relays]) }];
    }
    const kinds = unique(tags.filter((tag) => tag[0] === (root ? "K" : "k")).map((tag) => tag[1] ?? ""));
    if (!kinds.length) issues.push("missing-kind");
    else if (kinds.length > 1) issues.push("kind-conflict");
    const kind = kinds[0];
    const external = candidates.length === 1 && candidates[0].type === "external";
    const parsedKind = kind === undefined ? undefined : external ? kind || undefined : kindNumber(kind);
    if (kind !== undefined && parsedKind === undefined) issues.push("invalid-kind");
    const pubkeyTags = tags.filter((tag) => tag[0] === (root ? "P" : "p"));
    const authors = unique(pubkeyTags.map((tag) => hex(tag[1])).filter((value): value is string => !!value));
    if (pubkeyTags.some((tag) => !hex(tag[1]))) issues.push("invalid-author");
    if (!external && !authors.length) issues.push("missing-author");
    if (root && authors.length > 1) issues.push("author-conflict");
    candidates = candidates.map((target) => {
        if (target.kind !== undefined && parsedKind !== undefined && target.kind !== parsedKind) issues.push("kind-conflict");
        if (target.author && authors.length && !authors.includes(target.author)) issues.push("author-conflict");
        const author = target.author ?? (authors.length === 1 ? authors[0] : undefined);
        return { ...target, kind: parsedKind, author,
            relays: unique([...target.relays, ...pubkeyTags.filter((tag) => hex(tag[1]) === author).map((tag) => tag[2]).filter(Boolean)]) };
    });
    return claim(candidates, issues, authors);
}

/** NIP-10 and NIP-22 interpretation, without fetching, signatures or board policy. */
export function normalizeThreadRelations(event: Pick<Event, "kind" | "tags">): ThreadRelations {
    if (event.kind === 1111) return { protocol: "nip22", provenance: "nip22",
        root: commentClaim(event.tags, true), parent: commentClaim(event.tags, false) };
    if (event.kind !== 1) return { protocol: "none", provenance: "none", root: absent(), parent: absent() };
    const tags = event.tags.filter((tag) => tag[0] === "e");
    // Marked events cannot acquire a parent from an unmarked mention.
    if (tags.some((tag) => !!tag[3])) {
        const root = noteClaim(tags.filter((tag) => tag[3] === "root"));
        const replies = tags.filter((tag) => tag[3] === "reply");
        return { protocol: "nip10", provenance: "marked", root, parent: replies.length ? noteClaim(replies) : root };
    }
    // A sole positional reference establishes a parent, not the ultimate root.
    return { protocol: "nip10", provenance: "positional", root: tags.length > 1 ? noteClaim([tags[0]]) : absent(),
        parent: tags.length ? noteClaim([tags[tags.length - 1]]) : absent() };
}

export const relationKey = (target: RelationTarget) => target.type === "external" ?
    `external:${JSON.stringify([target.kind ?? null, target.value])}` : `${target.type}:${target.value}`;
