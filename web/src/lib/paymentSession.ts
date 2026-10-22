import { RELAY_HTTP, RELAY_PUBKEY } from "../config";
import { IndexedPaymentRecoveryStore, type PaymentRecoverySnapshot } from "./paymentRecoveryStore";

export const paymentBackend = { api: RELAY_HTTP.replace(/\/+$/, ""), relayPubkey: RELAY_PUBKEY };
export const paymentBackendKey = JSON.stringify(paymentBackend);
const LAST_PAYMENT = "holoboard-last-payment";
const PREFIX = "holoboard-payment:";
const store = new IndexedPaymentRecoveryStore();
const listeners = new Set<() => void>();
let cache: PaymentRecoverySnapshot = { payments: new Map(), lastPayment: null };
let status = { ready: false, persistent: false, saving: false, failed: false, unverifiedLegacy: false };
let unverifiedPayments: { key: string; value: string }[] = [];
let initialization: Promise<void> | undefined;
let writes = Promise.resolve();
const retryUpdates: ((snapshot: PaymentRecoverySnapshot) => void)[] = [];

const notify = () => listeners.forEach(listener => listener());
const setStatus = (next: typeof status) => { status = next; notify(); };
export const getPaymentSessionStatus = () => status;
export const subscribePaymentSessions = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const paymentSessionIsPersistent = () => status.persistent;

/** Only records carrying their original configured backend can cross formats.
 * Legacy raw records contain no backend evidence. Leave them untouched rather
 * than assigning them the backend that happens to be configured on this visit.
 */
export function hasPaymentProvenance(value: string): boolean {
    try {
        const backend = JSON.parse(value)?.recoveryBackend;
        return backend?.api === paymentBackend.api && backend?.relayPubkey === paymentBackend.relayPubkey;
    }
    catch { return false; }
}
/** Explicit private schema excludes author keys and connection credentials. */
const fields = ["recoveryBackend", "api", "relayPubkey", "note", "board", "invoice", "paymentHash", "amountSats", "noteId", "expiresAt", "promotionSats", "billboardFeeSats",
    "author", "payment_hash", "amount_sats", "expires_at", "nostr_pubkey", "tipStatus", "promotionPaid", "added", "authorShare", "publicZap", "notificationRequested",
    "billboardApplied", "feeConverted", "boardAttempt", "authorAttempt", "state", "walletId", "preimage", "feesPaidMsats", "draft", "amount", "amountSelection", "mode", "rank", "custom",
    "billboardEnabled", "config", "template", "color", "size", "speed", "text", "slides", "image", "notifyEnabled", "notifyPubkey", "editing", "noteSummary", "event", "publication",
    "id", "pubkey", "created_at", "kind", "tags", "content", "sig"];
export const serializePrivatePayment = (payment: unknown): string => JSON.stringify(payment, fields);

function legacyPayments() {
    const payments = new Map<string, string>();
    unverifiedPayments = [];
    let lastPayment: string | null = null, unverified = false;
    try {
        for (let index = 0; index < sessionStorage.length; index++) {
            const key = sessionStorage.key(index);
            if (!key?.startsWith(PREFIX)) continue;
            const value = sessionStorage.getItem(key);
            if (!value) continue;
            if (hasPaymentProvenance(value)) payments.set(key, serializePrivatePayment(JSON.parse(value)));
            else { unverified = true; unverifiedPayments.push({ key, value }); }
        }
        const last = sessionStorage.getItem(LAST_PAYMENT);
        if (last && payments.has(last)) lastPayment = last;
    } catch { /* Durable storage does not depend on access to tab storage. */ }
    return { payments, lastPayment, unverified };
}
export function initializePaymentSessions(): Promise<void> {
    if (initialization) return initialization;
    initialization = (async () => {
        const legacy = legacyPayments();
        cache = { payments: legacy.payments, lastPayment: legacy.lastPayment };
        try {
            cache = await store.change(paymentBackendKey, snapshot => {
                // Import without deleting or replacing any original tab record.
                for (const [key, value] of legacy.payments) if (!snapshot.payments.has(key)) snapshot.payments.set(key, value);
                if (!snapshot.lastPayment) snapshot.lastPayment = legacy.lastPayment;
            });
            setStatus({ ready: true, persistent: true, saving: false, failed: false, unverifiedLegacy: legacy.unverified });
        } catch { setStatus({ ready: true, persistent: false, saving: false, failed: true, unverifiedLegacy: legacy.unverified }); }
    })();
    return initialization;
}

export function readPaymentSession(key?: string): string | null {
    const target = key ?? cache.lastPayment;
    return target ? cache.payments.get(target) ?? null : null;
}
export const listUnverifiedPaymentSessions = () => [...unverifiedPayments];
export function listPaymentSessions(prefix: string): { key: string; value: string }[] {
    return [...cache.payments].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value }));
}

/** Each mutation re-reads the database inside its transaction, so a callback in
 * another tab cannot overwrite an unrelated hash or the current pointer.
 * Failed changes remain available in memory and are retried with the next write.
 */
export function changePaymentSessions(update: (snapshot: PaymentRecoverySnapshot) => void): Promise<boolean> {
    const run = writes.then(async () => {
        await initializePaymentSessions();
        update(cache);
        retryUpdates.push(update);
        setStatus({ ...status, persistent: false, saving: true });
        try {
            const next = await store.change(paymentBackendKey, snapshot => {
                // Reapply operations to current durable values, including writes
                // that previously failed. Never replace them with a stale cache.
                for (const retry of retryUpdates) retry(snapshot);
            });
            cache = next; retryUpdates.length = 0;
            setStatus({ ...status, persistent: true, saving: false, failed: false });
        } catch { setStatus({ ...status, persistent: false, saving: false, failed: true }); }
        return status.persistent;
    });
    writes = run.then(() => {}, () => {});
    return run;
}
/** Destructive operations have no optimistic mutation and no delayed retry.
 * Their caller holds all invoice hash locks until this transaction completes.
 */
export function changePaymentSessionsWithAttempts(update: (snapshot: PaymentRecoverySnapshot, attempts: Map<string, unknown>) => void): Promise<boolean> {
    const run = writes.then(async () => {
        await initializePaymentSessions();
        setStatus({ ...status, saving: true });
        try {
            const next = await store.changeWithWalletAttempts(paymentBackendKey, (snapshot, attempts) => {
                for (const retry of retryUpdates) retry(snapshot);
                update(snapshot, attempts);
            });
            cache = next; retryUpdates.length = 0;
            setStatus({ ...status, persistent: true, saving: false, failed: false });
            return true;
        } catch {
            setStatus({ ...status, saving: false, persistent: false, failed: true });
            return false;
        }
    });
    writes = run.then(() => {}, () => {});
    return run;
}
export function savePaymentSession(key: string, value: string, makeCurrent = true): Promise<boolean> {
    return changePaymentSessions(snapshot => {
        snapshot.payments.set(key, value);
        if (makeCurrent) snapshot.lastPayment = key;
    });
}
export function removePaymentSession(key: string): Promise<boolean> {
    return changePaymentSessions(snapshot => {
        snapshot.payments.delete(key);
        if (snapshot.lastPayment === key) snapshot.lastPayment = null;
    });
}
