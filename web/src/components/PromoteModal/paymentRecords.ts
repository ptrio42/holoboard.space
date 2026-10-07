import { isMockInvoice } from "../../lib/invoice";
import { parseNoteReference } from "../../lib/nostr";
import { listPaymentSessions, readPaymentSession, removePaymentSession, savePaymentSession } from "../../lib/paymentSession";
import { getWalletAttempt } from "../../lib/walletAttempts";
import type { PromotionPayment } from "./PaymentState";

export const paymentKey = (note: string) => `holoboard-payment:${parseNoteReference(note)?.id ?? note}`;
const archivedKey = (payment: PromotionPayment) => `${paymentKey(payment.note)}:${payment.board.paymentHash}`;
const complete = (payment: PromotionPayment) => payment.promotionPaid && (!payment.author || payment.tipStatus !== "pending");

function parsePayment(value: string | null): PromotionPayment | null {
    try {
        const payment = JSON.parse(value ?? "null") as PromotionPayment;
        if (!payment?.board || typeof payment.board.invoice !== "string" || typeof payment.board.paymentHash !== "string" || typeof payment.note !== "string") return null;
        if (parseNoteReference(payment.note)?.id !== payment.board.noteId) return null;
        return payment;
    } catch { return null; }
}

export function restorePayment(note: string): PromotionPayment | null {
    if (!parseNoteReference(note)) return null;
    const payment = parsePayment(readPaymentSession(paymentKey(note)));
    if (!payment || paymentKey(payment.note) !== paymentKey(note) || complete(payment) || (isMockInvoice(payment.board.invoice) && !payment.author)) return null;
    const expired = payment.board.expiresAt * 1000 <= Date.now() && (!payment.author || payment.author.expires_at * 1000 <= Date.now());
    const attempted = [getWalletAttempt(payment.board.paymentHash, payment.boardAttempt), payment.author && getWalletAttempt(payment.author.payment_hash, payment.authorAttempt)]
        .some((attempt) => attempt && attempt.state !== "unpaid");
    if (expired && !payment.promotionPaid && payment.tipStatus === "pending" && !attempted) return { ...payment, editing: true };
    return payment;
}

export function unfinishedPayments(note?: string): PromotionPayment[] {
    const seen = new Set<string>();
    return listPaymentSessions("holoboard-payment:").flatMap(({ key, value }) => {
        const payment = parsePayment(value);
        if (!payment || complete(payment) || (isMockInvoice(payment.board.invoice) && !payment.author) || (note && paymentKey(note) !== paymentKey(payment.note))) return [];
        const identity = archivedKey(payment);
        if (key !== paymentKey(payment.note) && key !== identity) return [];
        if (seen.has(identity)) return [];
        seen.add(identity);
        return [payment];
    }).reverse();
}

/** Preserve older invoices before another payment for the same note takes over. */
export function savePayment(payment: PromotionPayment): boolean {
    const key = paymentKey(payment.note);
    const previous = parsePayment(readPaymentSession(key));
    if (previous && previous.board.paymentHash !== payment.board.paymentHash && !complete(previous)) {
        savePaymentSession(archivedKey(previous), JSON.stringify({ ...previous, editing: true }), false);
    }
    removePaymentSession(archivedKey(payment));
    return savePaymentSession(key, JSON.stringify(payment));
}

export function updateSavedPayment(note: string, hash: string, changes: Partial<PromotionPayment>) {
    for (const key of [paymentKey(note), `${paymentKey(note)}:${hash}`]) {
        const current = parsePayment(readPaymentSession(key));
        if (current?.board.paymentHash !== hash) continue;
        // A late response may update its own archived session, but cannot
        // reopen the editor or replace another note's last-payment pointer.
        savePaymentSession(key, JSON.stringify({ ...current, ...changes }), false);
        return;
    }
}
