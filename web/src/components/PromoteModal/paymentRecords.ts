import { parseBillboard } from "../../lib/billboard";
import { verifiedNostrEvent } from "../../lib/verifyNostrEvent";
import { isMockInvoice } from "../../lib/invoice";
import { parseNoteReference } from "../../lib/nostr";
import { changePaymentSessions, hasPaymentProvenance, listPaymentSessions, listUnverifiedPaymentSessions, paymentBackend, readPaymentSession, serializePrivatePayment } from "../../lib/paymentSession";
import { getWalletAttempt, validWalletAttempt } from "../../lib/walletAttempts";
import type { PromotionPayment } from "./PaymentState";

export const paymentKey = (note: string) => `holoboard-payment:${parseNoteReference(note)?.id ?? note}`;
const archivedKey = (payment: PromotionPayment) => `${paymentKey(payment.note)}:${payment.board.paymentHash}`;
const complete = (payment: PromotionPayment) => payment.promotionPaid && (!payment.author || payment.tipStatus !== "pending");

function parsePayment(value: string | null): PromotionPayment | null {
    try {
        if (!value || !hasPaymentProvenance(value)) return null;
        const payment = JSON.parse(value) as PromotionPayment;
        if (!payment?.board || typeof payment.board.invoice !== "string" || typeof payment.board.paymentHash !== "string" || typeof payment.note !== "string") return null;
        const noteId = parseNoteReference(payment.note)?.id;
        if (!noteId || noteId !== payment.board.noteId) return null;
        if (![payment.board.amountSats, payment.board.promotionSats, payment.board.billboardFeeSats, payment.board.expiresAt, payment.added, payment.authorShare].every(value => Number.isSafeInteger(value) && value >= 0) || payment.authorShare > 99) return null;
        if (!payment.board.invoice || !payment.board.paymentHash || payment.board.amountSats < 1 || typeof payment.promotionPaid !== "boolean" || !["pending", "confirmed", "reported"].includes(payment.tipStatus)) return null;
        if (payment.author && (typeof payment.author.invoice !== "string" || !payment.author.invoice || typeof payment.author.payment_hash !== "string" || !payment.author.payment_hash ||
            !Number.isSafeInteger(payment.author.amount_sats) || payment.author.amount_sats < 1 || !Number.isSafeInteger(payment.author.expires_at) || typeof payment.author.author !== "string")) return null;
        if ([payment.boardAttempt, payment.authorAttempt].some(attempt => attempt !== undefined && !validWalletAttempt(attempt))) return null;
        if (payment.noteSummary !== undefined && typeof payment.noteSummary !== "string") return null;
        if ([payment.publicZap, payment.notificationRequested, payment.billboardApplied, payment.feeConverted, payment.editing].some(value => value !== undefined && typeof value !== "boolean")) return null;
        if (payment.publication !== undefined && !["pending", "delivered", "stopped"].includes(payment.publication)) return null;
        if (payment.event && (!verifiedNostrEvent(payment.event) || payment.event.id !== payment.board.noteId || payment.event.kind !== 1)) return null;
        const clean = JSON.parse(serializePayment(payment)) as PromotionPayment;
        // A corrupt optional draft must not hide otherwise valid invoices.
        // Invoice amounts remain exact; the editor can derive its defaults.
        if (clean.draft !== undefined && (!clean.draft || !validDraft(clean.draft))) delete clean.draft;
        return clean;
    } catch { return null; }
}

function validDraft(draft: NonNullable<PromotionPayment["draft"]>): boolean {
    const selection = draft.amountSelection, config = draft.config;
    return Number.isSafeInteger(draft.amount) && draft.amount >= 1 && draft.amount <= 10000000 &&
        Number.isInteger(draft.authorShare) && draft.authorShare >= 0 && draft.authorShare <= 99 &&
        !!selection && ["amount", "position"].includes(selection.mode) && typeof selection.custom === "boolean" &&
        (selection.rank === null || (Number.isSafeInteger(selection.rank) && selection.rank > 0)) &&
        typeof draft.billboardEnabled === "boolean" && typeof draft.notifyEnabled === "boolean" && typeof draft.notifyPubkey === "string" &&
        !!config && typeof config.text === "string" && !!parseBillboard(config.text ? config : { ...config, text: "Draft" });
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

/** Read-only access to original invoices, without selecting a backend or
 * consulting wallet attempts, status endpoints, or public caches.
 */
export type LegacyPaymentInvoices = Pick<PromotionPayment, "note" | "noteSummary"> & {
    board: Pick<PromotionPayment["board"], "invoice" | "paymentHash" | "noteId" | "amountSats">;
    author?: Pick<NonNullable<PromotionPayment["author"]>, "invoice" | "payment_hash" | "amount_sats">;
};
export function unverifiedLegacyPayments(): LegacyPaymentInvoices[] {
    return listUnverifiedPaymentSessions().flatMap(({ key, value }) => {
        try {
            const payment = JSON.parse(value) as PromotionPayment;
            if (!payment?.board || parseNoteReference(payment.note)?.id !== payment.board.noteId ||
                !payment.board.noteId || typeof payment.board.invoice !== "string" || !payment.board.invoice ||
                typeof payment.board.paymentHash !== "string" || !payment.board.paymentHash ||
                !Number.isSafeInteger(payment.board.amountSats) || payment.board.amountSats < 1 ||
                (key !== paymentKey(payment.note) && key !== archivedKey(payment))) return [];
            const board = { invoice: payment.board.invoice, paymentHash: payment.board.paymentHash, noteId: payment.board.noteId, amountSats: payment.board.amountSats };
            const author = payment.author;
            return [{ note: payment.note, noteSummary: typeof payment.noteSummary === "string" ? payment.noteSummary : undefined, board,
                ...(author && typeof author.invoice === "string" && author.invoice && typeof author.payment_hash === "string" &&
                    Number.isSafeInteger(author.amount_sats) && author.amount_sats > 0 ? { author: { invoice: author.invoice, payment_hash: author.payment_hash, amount_sats: author.amount_sats } } : {}) }];
        } catch { return []; }
    });
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

/** Persist only payment fields. Connections and guest keys are never part of
 * this schema, even if an untrusted compatibility record contains extra fields.
 */
const serializePayment = serializePrivatePayment;

/** A stale component or another tab may not erase a known settlement. */
function mergePayment(current: PromotionPayment, next: PromotionPayment): PromotionPayment {
    const attempt = (old: PromotionPayment["boardAttempt"], incoming: PromotionPayment["boardAttempt"]) =>
        old && (old.state === "submitted" || (old.state === "uncertain" && incoming?.state !== "submitted")) ? old : incoming ?? old;
    return { ...next,
        boardAttempt: attempt(current.boardAttempt, next.boardAttempt),
        authorAttempt: current.author?.payment_hash === next.author?.payment_hash ? attempt(current.authorAttempt, next.authorAttempt) : next.authorAttempt,
        board: current.board, event: current.event ?? next.event,
        promotionPaid: current.promotionPaid || next.promotionPaid,
        added: Math.max(current.added, next.added),
        tipStatus: current.author?.payment_hash === next.author?.payment_hash && current.tipStatus !== "pending"
            ? current.tipStatus === "confirmed" ? "confirmed" : next.tipStatus === "confirmed" ? "confirmed" : "reported" : next.tipStatus,
        publication: current.publication === "delivered" || current.publication === "stopped" ? current.publication : next.publication,
        billboardApplied: current.billboardApplied || next.billboardApplied, feeConverted: current.feeConverted || next.feeConverted,
    };
}

/** Preserve older invoices and select the requested hash in one transaction. */
export function savePayment(payment: PromotionPayment, select = true): Promise<boolean> {
    const prepared = { ...payment, recoveryBackend: payment.recoveryBackend ?? paymentBackend };
    const value = serializePayment(prepared);
    if (!parsePayment(value)) return Promise.resolve(false);
    return changePaymentSessions(snapshot => {
        const key = paymentKey(prepared.note);
        const previous = parsePayment(snapshot.payments.get(key) ?? null);
        if (!select) {
            for (const target of [key, archivedKey(prepared)]) {
                const current = parsePayment(snapshot.payments.get(target) ?? null);
                if (current?.board.paymentHash !== prepared.board.paymentHash) continue;
                snapshot.payments.set(target, serializePayment(mergePayment(current, { ...prepared, editing: current.editing })));
                return;
            }
            return;
        }
        const archived = parsePayment(snapshot.payments.get(archivedKey(prepared)) ?? null);
        if (previous && previous.board.paymentHash !== prepared.board.paymentHash) {
            // Keep even completed records: delayed callbacks may still belong to them.
            snapshot.payments.set(archivedKey(previous), serializePayment({ ...previous, editing: true }));
        }
        const current = previous?.board.paymentHash === prepared.board.paymentHash ? previous : archived;
        snapshot.payments.delete(archivedKey(prepared));
        snapshot.payments.set(key, serializePayment(current ? mergePayment(current, prepared) : prepared));
        snapshot.lastPayment = key;
    });
}

/** Clear only the selected, resolved/unattempted session, never a newer hash
 * that another page selected for the same note while this editor was open.
 */
export function removeSavedPayment(note: string, hash: string): Promise<boolean> {
    return changePaymentSessions(snapshot => {
        const key = paymentKey(note);
        const current = parsePayment(snapshot.payments.get(key) ?? null);
        if (current?.board.paymentHash !== hash) return;
        const unresolved = current.promotionPaid || current.tipStatus !== "pending" ||
            [current.boardAttempt, current.authorAttempt].some(attempt => attempt && attempt.state !== "unpaid");
        if (!complete(current) && unresolved) return;
        snapshot.payments.delete(key);
        if (snapshot.lastPayment === key) snapshot.lastPayment = null;
    });
}

export function updateSavedPayment(note: string, hash: string, changes: Partial<PromotionPayment>): Promise<boolean> {
    return changePaymentSessions(snapshot => {
        for (const key of [paymentKey(note), `${paymentKey(note)}:${hash}`]) {
            const current = parsePayment(snapshot.payments.get(key) ?? null);
            if (current?.board.paymentHash !== hash) continue;
            // Late callbacks can update only their own invoice. Identity, original
            // signed event, editing selection and last-payment pointer stay intact.
            const next = mergePayment(current, { ...current, ...changes, note: current.note, board: current.board,
                author: current.author, event: current.event, recoveryBackend: current.recoveryBackend, editing: current.editing });
            snapshot.payments.set(key, serializePayment(next));
            return;
        }
    });
}
