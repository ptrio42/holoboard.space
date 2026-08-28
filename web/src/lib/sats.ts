/**
 * Client for the relay's payment ledger.
 *
 * A nostr event is signed over its own tags, so the relay cannot write a note's
 * sats total onto the note without invalidating the signature and having every
 * client throw it away. It serves the figures separately instead, over plain
 * HTTP on the same host, and this reads them.
 *
 * The cost of that split is staleness: the notes arrive on a live subscription,
 * the numbers beside them are polled. See useSatsMap for the refresh.
 */

export interface LedgerEntry {
    /** Event id of the promoted note. */
    id: string;
    /** Everything this note has been paid, in sats. */
    satsPaid: number;
    /** Unix seconds of the most recent payment, 0 if somehow never paid. */
    lastPaidAt: number;
    /** 1-based position in the relay's own ranking. */
    rank: number;
}

export interface Ledger {
    entries: LedgerEntry[];
    posts: number;
    totalSats: number;
    updatedAt: number;
}

export type SatsMap = ReadonlyMap<string, number>;

/** Anything at all, narrowed as we go. Ledger JSON comes off the network. */
type Unknown = Record<string, unknown>;

const isObject = (value: unknown): value is Unknown =>
    typeof value === "object" && value !== null;

const asNumber = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;

/**
 * Reads one entry, or null if it is not usable. An entry without an id cannot
 * be joined to a note, so it is dropped rather than carried around as a hole.
 */
function parseEntry(value: unknown): LedgerEntry | null {
    if (!isObject(value)) return null;
    if (typeof value.id !== "string" || value.id.length === 0) return null;

    return {
        id: value.id,
        satsPaid: asNumber(value.sats_paid),
        lastPaidAt: asNumber(value.last_paid_at),
        rank: asNumber(value.rank),
    };
}

export function parseLedger(payload: unknown): Ledger {
    if (!isObject(payload)) throw new Error("ledger response was not an object");

    const rawEntries = Array.isArray(payload.entries) ? payload.entries : [];
    const entries = rawEntries
        .map(parseEntry)
        .filter((entry): entry is LedgerEntry => entry !== null);

    return {
        entries,
        posts: asNumber(payload.posts),
        totalSats: asNumber(payload.total_sats),
        updatedAt: asNumber(payload.updated_at),
    };
}

export async function fetchLedger(endpoint: string, signal?: AbortSignal): Promise<Ledger> {
    const response = await fetch(endpoint, {
        signal,
        headers: { Accept: "application/json" },
    });

    if (!response.ok) {
        throw new Error(`ledger request failed with ${response.status}`);
    }

    return parseLedger(await response.json());
}

export function toSatsMap(ledger: Ledger): SatsMap {
    return new Map(ledger.entries.map((entry) => [entry.id, entry.satsPaid]));
}
