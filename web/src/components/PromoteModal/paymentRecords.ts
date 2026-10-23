import { parseBillboard } from "../../lib/billboard";
import { verifiedNostrEvent } from "../../lib/verifyNostrEvent";
import { isMockInvoice } from "../../lib/invoice";
import { parseNoteReference } from "../../lib/nostr";
import { changePaymentSessionsWithAttempts, changePaymentSessions, hasPaymentProvenance, listPaymentSessions, listUnverifiedPaymentSessions, paymentBackend, readPaymentSession, serializePrivatePayment } from "../../lib/paymentSession";
import { getWalletAttempt, validWalletAttempt, initializeWalletAttempts, withWalletAttemptLocks, walletAttemptBlocksRemoval } from "../../lib/walletAttempts";
import type { PromoteInvoice } from "../../lib/promote";
import type { AuthorInvoice } from "../../lib/support";
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
        if (clean.sourceEvent && (!verifiedNostrEvent(clean.sourceEvent) || clean.sourceEvent.id !== clean.board.noteId || clean.sourceEvent.kind !== 1)) delete clean.sourceEvent;
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
    // Reading a parsed invoice snapshot must not import its old attempt back
    // over a committed wallet resolution. Send actions reconcile their callers.
    const attempted = [getWalletAttempt(payment.board.paymentHash) ?? payment.boardAttempt,
        payment.author && (getWalletAttempt(payment.author.payment_hash) ?? payment.authorAttempt)]
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

function mergeAttempt(current: PromotionPayment["boardAttempt"], next: PromotionPayment["boardAttempt"], resolved = false): PromotionPayment["boardAttempt"] {
    if (!current) return next;
    if (current.state === "submitted") return next?.state === "submitted" ? { ...current, ...next, preimage: next.preimage ?? current.preimage } : current;
    if (current.state === "uncertain" && next?.state !== "submitted" && !(resolved && next?.state === "unpaid")) return current;
    return next ?? current;
}

/** Ordinary snapshots never replace an issued recipient invoice. Stale author
 * state can contribute only when its author hash matches the stored invoice.
 */
function mergePayment(current: PromotionPayment, next: PromotionPayment): PromotionPayment {
    const sameAuthor = !!current.author && current.author.payment_hash === next.author?.payment_hash;
    return { ...next, author: current.author,
        boardAttempt: mergeAttempt(current.boardAttempt, next.boardAttempt),
        authorAttempt: sameAuthor ? mergeAttempt(current.authorAttempt, next.authorAttempt) : current.authorAttempt,
        board: current.board, event: current.event ?? next.event, sourceEvent: current.sourceEvent ?? next.sourceEvent,
        promotionPaid: current.promotionPaid || next.promotionPaid,
        added: Math.max(current.added, next.added),
        tipStatus: sameAuthor ? current.tipStatus === "confirmed" || next.tipStatus === "confirmed" ? "confirmed"
            : current.tipStatus === "reported" || next.tipStatus === "reported" ? "reported" : "pending" : current.tipStatus,
        publicZap: sameAuthor ? next.publicZap : current.publicZap,
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
export async function removeSavedPayment(note: string, hash: string): Promise<boolean> {
    const key = paymentKey(note);
    const selected = parsePayment(readPaymentSession(key));
    if (selected?.board.paymentHash !== hash) return false;
    // Archiving completed invoices preserves payment facts, including late proof
    // callbacks. It does not need permission to treat any recipient as unpaid.
    if (complete(selected)) return changePaymentSessions(snapshot => {
        const current = parsePayment(snapshot.payments.get(key) ?? null);
        if (current?.board.paymentHash !== hash || !complete(current)) return;
        snapshot.payments.set(archivedKey(current), serializePayment({ ...current, editing: true }));
        snapshot.payments.delete(key);
        if (snapshot.lastPayment === key) snapshot.lastPayment = null;
    });
    const hashes = [hash, ...(selected.author ? [selected.author.payment_hash] : [])];
    try {
        return await withWalletAttemptLocks(hashes, async () => {
            await initializeWalletAttempts();
            let removed = false;
            const committed = await changePaymentSessionsWithAttempts((snapshot, attempts) => {
                const current = parsePayment(snapshot.payments.get(key) ?? null);
                if (current?.board.paymentHash !== hash || current.author?.payment_hash !== selected.author?.payment_hash) return;
                const unresolved = current.promotionPaid || current.tipStatus !== "pending" ||
                    [current.boardAttempt, current.authorAttempt].some(attempt => attempt && attempt.state !== "unpaid") ||
                    hashes.some(part => walletAttemptBlocksRemoval(part, attempts.get(part)));
                if (unresolved) return;
                snapshot.payments.delete(key);
                if (snapshot.lastPayment === key) snapshot.lastPayment = null;
                removed = true;
            });
            return committed && removed;
        });
    } catch { return false; }
}

export function updateSavedPayment(note: string, hash: string, changes: Partial<PromotionPayment>, expectedAuthorHash?: string): Promise<boolean> {
    return changePaymentSessions(snapshot => {
        for (const key of [paymentKey(note), `${paymentKey(note)}:${hash}`]) {
            const current = parsePayment(snapshot.payments.get(key) ?? null);
            if (current?.board.paymentHash !== hash) continue;
            // Late callbacks can update only their own invoice. Identity, original
            // signed event, editing selection and last-payment pointer stay intact.
            const authorMatches = !!expectedAuthorHash && current.author?.payment_hash === expectedAuthorHash;
            const next = mergePayment(current, { ...current, ...changes, note: current.note, board: current.board,
                author: current.author, event: current.event, recoveryBackend: current.recoveryBackend, editing: current.editing,
                tipStatus: authorMatches ? changes.tipStatus ?? current.tipStatus : current.tipStatus,
                authorAttempt: authorMatches ? changes.authorAttempt ?? current.authorAttempt : current.authorAttempt,
                publicZap: current.publicZap });
            // These callbacks include explicit lookup/acknowledgement outcomes.
            // Autosave cannot release an uncertain attempt by copying old state.
            next.boardAttempt = mergeAttempt(current.boardAttempt, changes.boardAttempt, true);
            if (authorMatches) next.authorAttempt = mergeAttempt(current.authorAttempt, changes.authorAttempt, true);
            snapshot.payments.set(key, serializePayment(next));
            return;
        }
    });
}

/** Recipient replacement rechecks the original hashes and unresolved state in
 * the transaction. It derives the other recipient from current durable state.
 */
async function replaceSavedInvoice(note: string, boardHash: string, replace: (current: PromotionPayment) => PromotionPayment | null): Promise<PromotionPayment | null> {
    let replaced: PromotionPayment | null = null;
    await changePaymentSessions(snapshot => {
        replaced = null;
        const main = paymentKey(note);
        for (const key of [main, `${main}:${boardHash}`]) {
            const current = parsePayment(snapshot.payments.get(key) ?? null);
            if (current?.board.paymentHash !== boardHash) continue;
            const next = replace(current);
            if (!next || !parsePayment(serializePayment(next))) return;
            if (next.board.paymentHash !== boardHash) {
                snapshot.payments.set(archivedKey(current), serializePayment({ ...current, editing: true }));
            }
            snapshot.payments.set(key === main ? main : archivedKey(next), serializePayment(next));
            replaced = next;
            return;
        }
    });
    return replaced;
}

export function replaceSavedAuthorInvoice(note: string, boardHash: string, authorHash: string, author: AuthorInvoice, publicZap: boolean): Promise<PromotionPayment | null> {
    return replaceSavedInvoice(note, boardHash, current => {
        if (!current.author || current.author.payment_hash !== authorHash || current.tipStatus !== "pending" ||
            current.author.expires_at * 1000 > Date.now() || (current.authorAttempt && current.authorAttempt.state !== "unpaid") ||
            author.payment_hash === authorHash || author.amount_sats !== current.author.amount_sats || author.author !== current.author.author) return null;
        return { ...current, author, authorAttempt: undefined, tipStatus: "pending", publicZap };
    });
}

export function replaceSavedBoardInvoice(note: string, boardHash: string, board: PromoteInvoice, notificationRequested: boolean): Promise<PromotionPayment | null> {
    return replaceSavedInvoice(note, boardHash, current => {
        if (current.promotionPaid || current.board.expiresAt * 1000 > Date.now() ||
            (current.boardAttempt && current.boardAttempt.state !== "unpaid") || board.paymentHash === boardHash ||
            board.noteId !== current.board.noteId || board.amountSats !== current.board.amountSats) return null;
        return { ...current, board, boardAttempt: undefined, notificationRequested, promotionPaid: false,
            added: 0, publication: undefined, billboardApplied: undefined, feeConverted: undefined };
    });
}
