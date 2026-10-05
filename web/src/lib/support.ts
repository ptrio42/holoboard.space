import type { Event, EventTemplate } from "nostr-tools/pure";
import { verifyEvent } from "nostr-tools/pure";
import { PUBLIC_RELAYS, RELAY_HTTP } from "../config";
import { getConnectedSigner, getPaymentWallet } from "./connections";

export interface AuthorEndpoint {
    available: boolean; author: string; reason?: string; reason_code?: "no_address" | "unavailable"; min_sats: number; max_sats: number;
    allows_nostr: boolean; nostr_pubkey?: string;
}
export interface AuthorInvoice { invoice: string; payment_hash: string; amount_sats: number; expires_at: number; author: string; nostr_pubkey?: string }
export const browserWallet = getPaymentWallet;
export const browserSigner = getConnectedSigner;

async function supportRequest(path: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await fetch(`${RELAY_HTTP}/api/support${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Author payment request failed.");
    return data;
}
export async function fetchAuthorEndpoint(note: string, signal?: AbortSignal): Promise<AuthorEndpoint> {
    return await supportRequest("", { note }, signal) as unknown as AuthorEndpoint;
}
export function allocatePayment(total: number, authorShare: number): { promotion: number; author: number } {
    if (!Number.isSafeInteger(total) || total < 1 || !Number.isInteger(authorShare) || authorShare < 0 || authorShare > 99) throw new Error("Invalid payment allocation.");
    const author = Math.min(total - 1, Math.floor(total * authorShare / 100));
    return { promotion: total - author, author };
}
export function totalForPromotion(promotion: number, authorShare: number): number {
    let total = Math.max(1, Math.ceil(promotion * 100 / (100-authorShare)));
    while (total > 1 && allocatePayment(total-1, authorShare).promotion >= promotion) total--;
    return total;
}
export async function requestAuthorInvoice(note: string, amount: number, endpoint: AuthorEndpoint, publicZap: boolean, noteId: string, signal?: AbortSignal): Promise<AuthorInvoice> {
    let zap: Event | undefined;
    if (publicZap) {
        const signer = browserSigner();
        if (!signer || !endpoint.allows_nostr) throw new Error("A Nostr signer and a zap-enabled author wallet are required for a public zap.");
        const template: EventTemplate = { kind: 9734, created_at: Math.floor(Date.now()/1000), content: "", tags: [["p", endpoint.author], ["e", noteId], ["amount", String(amount*1000)], ["relays", ...PUBLIC_RELAYS]] };
        zap = await signer.signEvent(template);
        if (!verifyEvent(zap) || zap.kind !== template.kind || zap.content !== template.content || JSON.stringify(zap.tags) !== JSON.stringify(template.tags)) throw new Error("The signer changed the author payment request.");
    }
    const invoice = await supportRequest("/invoice", { note, amount_sats: amount, ...(zap ? { zap_request: zap } : {}) }, signal);
    if (typeof invoice.invoice !== "string" || typeof invoice.payment_hash !== "string" || invoice.amount_sats !== amount || invoice.author !== endpoint.author) throw new Error("Incomplete author payment invoice.");
    return invoice as unknown as AuthorInvoice;
}
export async function verifyAuthorPayment(note: string, invoice: AuthorInvoice, proof: { preimage?: string; receipt?: Event }): Promise<boolean> {
    const result = await supportRequest("/verify", { note, invoice: invoice.invoice, ...proof });
    return result.verified === true;
}
