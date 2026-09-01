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
}

export interface PromoteProgress {
    /** Whether the invoice is still outstanding. */
    pending: boolean;
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
): Promise<PromoteInvoice> {
    const response = await fetch(`${RELAY_HTTP}/api/promote`, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note, amount_sats: amountSats }),
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
        satsPaid: typeof body.sats_paid === "number" ? body.sats_paid : 0,
    };
}
