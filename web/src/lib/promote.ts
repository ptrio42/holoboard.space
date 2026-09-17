import type { NDKRawEvent } from "@nostr-dev-kit/ndk";
import { parseBillboard, type BillboardConfig } from "./billboard";
/**
 * Promoting a note without an identity.
 *
 * The relay never checks who asked for a promotion; crediting comes from the
 * payment. So the whole flow is: hand it a note, get a bolt11, pay it. No
 * signer, no extension, which is what makes this the path that works on a
 * phone.
 */

import { RELAY_HTTP } from "../config";

export interface PromoteInvoice {
    invoice: string;
    paymentHash: string;
    amountSats: number;
    noteId: string;
    expiresAt: number;
    promotionSats: number;
    billboardFeeSats: number;
}

export interface PromoteProgress {
    /** Whether the invoice is still outstanding. */
    pending: boolean;
    settled: boolean;
    feeConverted: boolean;
    billboardApplied: boolean;
    /** What the note has collected right now. */
    satsPaid: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

/**
 * Turns whatever fetch threw into something worth reading. A failed request
 * rejects with a bare TypeError whose message is "Failed to fetch", which tells
 * somebody staring at the dialog nothing at all about what to do next.
 *
 * That TypeError does not mean the relay was unreachable, and saying so sent us
 * chasing a connectivity problem that did not exist. A 502 from the Fly proxy
 * carries no CORS headers, because the proxy rather than the app produced it, so
 * the browser refuses to let the response be read and the rejection looks
 * identical to a dead network. Name the symptom, not a cause we cannot see.
 */
export function describeFailure(error: unknown): string {
    if (error instanceof DOMException && error.name === "AbortError") {
        return "cancelled";
    }
    if (error instanceof TypeError) {
        return "the request to the relay did not get through. Try again in a moment.";
    }
    return error instanceof Error ? error.message : "something went wrong";
}

/** Pulls the relay's error message out, so the user sees why rather than a code. */
async function readError(response: Response): Promise<string> {
    try {
        const body: unknown = await response.json();
        if (isObject(body) && typeof body.error === "string") return body.error;
    } catch {
        // fall through to the generic message
    }
    return `the relay answered ${response.status}`;
}

export async function requestInvoice(
    note: string,
    amountSats: number,
    signal?: AbortSignal,
    appearance?: { billboard: BillboardConfig },
): Promise<PromoteInvoice> {
    const response = await fetch(`${RELAY_HTTP}/api/promote`, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note, amount_sats: amountSats, ...(appearance ? { billboard: appearance.billboard } : {}) }),
    });

    if (!response.ok) throw new Error(await readError(response));

    const body: unknown = await response.json();
    if (!isObject(body) || typeof body.invoice !== "string" || typeof body.payment_hash !== "string") {
        throw new Error("the relay sent something unexpected");
    }

    return {
        invoice: body.invoice,
        paymentHash: body.payment_hash,
        amountSats: typeof body.amount_sats === "number" ? body.amount_sats : amountSats,
        noteId: typeof body.note_id === "string" ? body.note_id : "",
        expiresAt: typeof body.expires_at === "number" ? body.expires_at : 0,
        promotionSats: typeof body.promotion_sats === "number" ? body.promotion_sats : amountSats,
        billboardFeeSats: typeof body.billboard_fee_sats === "number" ? body.billboard_fee_sats : 0,
    };
}

export async function checkProgress(
    paymentHash: string,
    note: string,
    signal?: AbortSignal,
): Promise<PromoteProgress> {
    const url = new URL(`${RELAY_HTTP}/api/promote/status`);
    url.searchParams.set("payment_hash", paymentHash);
    url.searchParams.set("note", note);

    const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(await readError(response));

    const body: unknown = await response.json();
    if (!isObject(body)) throw new Error("the relay sent something unexpected");

    return {
        pending: body.pending === true,
        settled: body.settled === true,
        feeConverted: isObject(body.receipt) && body.receipt.fee_converted === true,
        billboardApplied: isObject(body.receipt) && body.receipt.billboard_applied === true,
        satsPaid: typeof body.sats_paid === "number" ? body.sats_paid : 0,
    };
}


export interface NotePreview {
    event: NDKRawEvent;
    active: boolean;
    satsPaid: number;
    weight: number;
    rank: number;
    billboard?: BillboardConfig;
    billboardFeeSats: number;
    images: string[];
}

export async function fetchNotePreview(note: string, signal?: AbortSignal): Promise<NotePreview> {
    const response = await fetch(`${RELAY_HTTP}/api/promote/preview`, {
        method: "POST", signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
    });
    if (!response.ok) throw new Error(await readError(response));
    const body: unknown = await response.json();
    if (!isObject(body) || !isObject(body.event) || typeof body.event.id !== "string" ||
        typeof body.event.pubkey !== "string" || typeof body.event.content !== "string" ||
        typeof body.event.kind !== "number" || typeof body.event.created_at !== "number" ||
        typeof body.event.sig !== "string" || !Array.isArray(body.event.tags) ||
        typeof body.billboard_fee_sats !== "number" || !Number.isSafeInteger(body.billboard_fee_sats) || body.billboard_fee_sats < 0 ||
        !Array.isArray(body.images) || !body.images.every((image) => typeof image === "string" && /^https?:\/\//i.test(image))) {
        throw new Error("The preview response was incomplete.");
    }
    return {
        event: body.event as unknown as NDKRawEvent, active: body.active === true,
        satsPaid: typeof body.sats_paid === "number" ? body.sats_paid : 0,
        weight: typeof body.weight === "number" ? body.weight : 0,
        rank: typeof body.rank === "number" ? body.rank : 0,
        billboard: parseBillboard(body.billboard), billboardFeeSats: body.billboard_fee_sats,
        images: body.images as string[],
    };
}
