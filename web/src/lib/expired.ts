import type { NDKRawEvent } from "@nostr-dev-kit/ndk";
import { RELAY_HTTP } from "../config";

export interface ExpiredEntry {
    event: NDKRawEvent;
    satsPaid: number;
    lastPaidAt: number;
}

export interface ExpiredPage {
    entries: ExpiredEntry[];
    nextCursor: string | null;
}

export async function fetchExpired(cursor?: string, signal?: AbortSignal): Promise<ExpiredPage> {
    const url = new URL(`${RELAY_HTTP}/api/board/expired`);
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("Could not load expired notes. Try again.");
    const body = await response.json();
    if (!body || !Array.isArray(body.entries)) throw new Error("The archive response was incomplete.");
    const entries: ExpiredEntry[] = body.entries.map((entry: Record<string, unknown>) => {
        const event = entry.event as NDKRawEvent | undefined;
        if (!event || typeof event.id !== "string" || typeof event.pubkey !== "string" ||
            typeof event.content !== "string" || !Array.isArray(event.tags) ||
            typeof event.created_at !== "number" || typeof event.kind !== "number" ||
            typeof entry.sats_paid !== "number" || !Number.isFinite(entry.sats_paid) ||
            typeof entry.last_paid_at !== "number" || !Number.isFinite(entry.last_paid_at)) {
            throw new Error("The archive response was incomplete.");
        }
        return { event, satsPaid: entry.sats_paid, lastPaidAt: entry.last_paid_at };
    });
    if (body.next_cursor !== undefined && typeof body.next_cursor !== "string") {
        throw new Error("The archive response was incomplete.");
    }
    return { entries, nextCursor: body.next_cursor || null };
}
