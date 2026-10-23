import type { WalletAttempt } from "./walletPayment";
import { validWalletPreimage } from "./walletInvoice";
import { IndexedPaymentRecoveryStore } from "./paymentRecoveryStore";

interface AttemptRecord { attempt: WalletAttempt; invoice?: string; amountMsats?: number; revision?: number }
const KEY = "holoboard-wallet-attempts";
const store = new IndexedPaymentRecoveryStore();
const records = new Map<string, AttemptRecord>();
const snapshotRevisions = new WeakMap<WalletAttempt, number>();
const invalid = new Set<string>();
const listeners = new Set<() => void>();
const proofChecks = new Map<string, Promise<boolean>>();
const verifiedProofs = new Set<string>();
let loaded = false, persistent = false, unreadableLegacy = false;
let initializing: Promise<void> | undefined;
let snapshot: ReadonlyMap<string, WalletAttempt> = new Map();
const refreshSnapshot = () => { snapshot = new Map([...records].map(([hash, record]) => [hash, record.attempt])); };
const notify = () => { refreshSnapshot(); listeners.forEach((listener) => listener()); };
const proofKey = (hash: string, preimage: string) => `${hash}:${preimage.toLowerCase()}`;
const validHash = (hash: string) => /^[0-9a-f]{64}$/.test(hash);
const strength = (attempt: WalletAttempt) => ({ unpaid: 0, uncertain: 1, submitted: 2 })[attempt.state];
const blocked = () => new Error("Private wallet storage or cross-tab coordination is unavailable. Use Invoice / QR or check the original wallet. No wallet payment was sent.");

/** Verification stays in memory and is recomputed after restoring private storage. */
export function verifyWalletPaymentProof(hash: string, preimage: string | undefined): Promise<boolean> {
    if (typeof preimage !== "string") return Promise.resolve(false);
    const key = proofKey(hash, preimage);
    const existing = proofChecks.get(key);
    if (existing) return existing;
    const check = validWalletPreimage(preimage, hash).catch(() => false).then((valid) => {
        if (valid) {
            verifiedProofs.add(key);
            const attempt = records.get(hash)?.attempt;
            if (attempt?.state === "submitted" && typeof attempt.preimage === "string" && proofKey(hash, attempt.preimage) === key) notify();
        }
        return valid;
    });
    proofChecks.set(key, check);
    return check;
}
export function walletAttemptIsConfirmed(hash: string, attempt?: WalletAttempt): boolean {
    return attempt?.state === "submitted" && typeof attempt.preimage === "string" && verifiedProofs.has(proofKey(hash, attempt.preimage));
}
function checkRestoredProof(hash: string, attempt: WalletAttempt) {
    if (attempt.state === "submitted") void verifyWalletPaymentProof(hash, attempt.preimage);
}
export const walletAttemptsArePersistent = () => persistent && typeof navigator !== "undefined" && !!navigator.locks?.request;
export const getWalletAttemptsSnapshot = () => { load(); return snapshot; };
export const subscribeWalletAttempts = (listener: () => void) => { load(); listeners.add(listener); return () => { listeners.delete(listener); }; };
export function validWalletAttempt(value: unknown): value is WalletAttempt {
    if (!value || typeof value !== "object") return false;
    const attempt = value as WalletAttempt;
    return ["unpaid", "uncertain", "submitted"].includes(attempt.state) && typeof attempt.walletId === "string" &&
        !!attempt.walletId && attempt.walletId.length <= 200 && !attempt.walletId.includes("://") && !/[?&=\s]/.test(attempt.walletId) &&
        (attempt.preimage === undefined || typeof attempt.preimage === "string");
}
function cleanAttempt(attempt: WalletAttempt): WalletAttempt {
    return { state: attempt.state, walletId: attempt.walletId, ...(attempt.preimage === undefined ? {} : { preimage: attempt.preimage }) };
}
function parseRecord(value: unknown): AttemptRecord | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || !validWalletAttempt((value as AttemptRecord).attempt)) throw new Error("The stored wallet attempt is malformed or unknown. Check the original wallet before continuing.");
    const record = value as AttemptRecord;
    if ((record.revision !== undefined && (!Number.isSafeInteger(record.revision) || record.revision < 0)) ||
        (record.invoice !== undefined && typeof record.invoice !== "string") ||
        (record.amountMsats !== undefined && (!Number.isSafeInteger(record.amountMsats) || record.amountMsats <= 0))) throw new Error("The stored wallet attempt is malformed. Check the original wallet.");
    return { attempt: cleanAttempt(record.attempt), ...(record.invoice ? { invoice: record.invoice } : {}),
        ...(record.amountMsats === undefined ? {} : { amountMsats: record.amountMsats }), ...(record.revision === undefined ? {} : { revision: record.revision }) };
}
/** Ordinary cache/import writes can only add protection. Resolution needs a lock. */
function protect(existing: AttemptRecord | undefined, incoming: AttemptRecord | undefined, hash: string): AttemptRecord | undefined {
    if (!incoming) return existing;
    if (!existing) return incoming;
    // A delayed read cannot undo a newer committed resolution. Unknown-revision
    // barriers and verified preimages retain their independent protection.
    const knownOlder = incoming.revision !== undefined && existing.revision !== undefined && incoming.revision < existing.revision;
    if (knownOlder && !walletAttemptIsConfirmed(hash, incoming.attempt)) return existing;
    const strongerProof = incoming.attempt.state === "submitted" && existing.attempt.state === "submitted" &&
        ((!existing.attempt.preimage && !!incoming.attempt.preimage) ||
            (walletAttemptIsConfirmed(hash, incoming.attempt) && !walletAttemptIsConfirmed(hash, existing.attempt)));
    const useIncoming = strength(incoming.attempt) > strength(existing.attempt) || strongerProof;
    const walletId = existing.attempt.state === "unpaid" ? incoming.attempt.walletId : existing.attempt.walletId;
    const merged = { ...incoming, ...existing, attempt: useIncoming ? { ...incoming.attempt, walletId } : existing.attempt };
    const revision = (useIncoming ? incoming : existing).revision;
    if (revision === undefined) delete merged.revision;
    else merged.revision = revision;
    return merged;
}
function remember(hash: string, record: AttemptRecord) {
    records.set(hash, record);
    if (record.revision !== undefined) snapshotRevisions.set(record.attempt, record.revision);
    checkRestoredProof(hash, record.attempt); notify();
}
function load() {
    if (loaded) return;
    loaded = true;
    const retain = (hash: unknown, attempt: unknown, invoice?: string, amountMsats?: number) => {
        if (typeof hash !== "string" || !validHash(hash) || attempt === undefined) return;
        if (!validWalletAttempt(attempt)) { invalid.add(hash); return; }
        records.set(hash, protect(records.get(hash), { attempt: cleanAttempt(attempt), ...(typeof invoice === "string" ? { invoice } : {}),
            ...(Number.isSafeInteger(amountMsats) && amountMsats! > 0 ? { amountMsats } : {}) }, hash)!);
    };
    try {
        const parsed = JSON.parse(sessionStorage.getItem(KEY) ?? "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) unreadableLegacy = true;
        else for (const [hash, record] of Object.entries(parsed)) {
            if (!validHash(hash)) continue;
            try { const value = parseRecord(record); if (value) retain(hash, value.attempt, value.invoice, value.amountMsats); }
            catch { invalid.add(hash); }
        }
        // Preserve legacy hash barriers without assigning their invoices to an API backend.
        for (let index = 0; index < sessionStorage.length; index++) {
            const key = sessionStorage.key(index);
            if (!key || (!key.startsWith("holoboard-wallet-activity:") && !key.startsWith("holoboard-payment:"))) continue;
            try {
                const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
                if (key.startsWith("holoboard-wallet-activity:")) {
                    for (const [hash, attempt] of Object.entries(value?.attempts ?? {})) retain(hash, attempt, value.send?.paymentHash === hash ? value.send.invoice : undefined, value.send?.paymentHash === hash ? value.send.amountMsats : undefined);
                    retain(value?.send?.paymentHash, value?.send?.attempt, value?.send?.invoice, value?.send?.amountMsats);
                } else {
                    retain(value?.board?.paymentHash, value?.boardAttempt, value?.board?.invoice, value?.board?.amountSats * 1000);
                    retain(value?.author?.payment_hash, value?.authorAttempt, value?.author?.invoice, value?.author?.amount_sats * 1000);
                }
            } catch { unreadableLegacy = true; }
        }
    } catch { unreadableLegacy = true; }
    refreshSnapshot();
    records.forEach((record, hash) => checkRestoredProof(hash, record.attempt));
    queueMicrotask(() => { void initializeWalletAttempts(); });
}
async function refreshWalletAttempts() {
    try {
        for (const [hash, raw] of await store.readWalletAttempts()) {
            if (!validHash(hash)) continue;
            try {
                const record = parseRecord(raw);
                if (!record) continue;
                const before = records.get(hash);
                if (record.attempt.state === "submitted") await verifyWalletPaymentProof(hash, record.attempt.preimage);
                if (before?.attempt.state === "submitted") await verifyWalletPaymentProof(hash, before.attempt.preimage);
                const local = records.get(hash);
                // A newer authoritative resolution can release uncertainty, but never submitted proof.
                const resolvedNewer = (!local || local.revision !== undefined) && local?.attempt.state !== "submitted" &&
                    (record.revision ?? 0) > (local?.revision ?? 0);
                const next = resolvedNewer ? record : protect(local, record, hash)!;
                records.set(hash, next);
                if (next.revision !== undefined) snapshotRevisions.set(next.attempt, next.revision);
                checkRestoredProof(hash, next.attempt);
            } catch { invalid.add(hash); }
        }
        persistent = true; notify();
    } catch { persistent = false; notify(); }
}
export function initializeWalletAttempts(): Promise<void> {
    if (initializing) return initializing;
    load();
    const legacy = new Map(records);
    initializing = (async () => {
        try {
            for (const [hash, record] of legacy) {
                if (record.attempt.state === "unpaid") continue;
                await reconcileAttempt(hash, record.invoice, record.amountMsats);
            }
            for (const hash of invalid) await store.changeWalletAttempt(hash, raw => raw ?? { invalid: true });
            await refreshWalletAttempts();
        } catch { persistent = false; notify(); }
    })();
    return initializing;
}
// Messages carry no payment data and only request a fresh authoritative read.
const channel = typeof window !== "undefined" && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("holoboard-wallet-attempts-v1") : undefined;
if (channel) channel.onmessage = () => { void refreshWalletAttempts(); };
if (typeof window !== "undefined") window.addEventListener("focus", () => { void refreshWalletAttempts(); });

export function getWalletAttempt(hash: string, previous?: WalletAttempt): WalletAttempt | undefined {
    load();
    if (previous && validWalletAttempt(previous)) {
        const record = records.get(hash);
        // Only a snapshot whose committed revision is known can be stale.
        // Unknown caller uncertainty may reflect a failed write in another view.
        const knownRevision = snapshotRevisions.get(previous);
        const resolvedLater = record?.attempt.state === "unpaid" && knownRevision !== undefined && (record.revision ?? 0) > knownRevision;
        if (!resolvedLater) {
            const next = protect(record, { attempt: cleanAttempt(previous) }, hash)!;
            if (previous.state === "uncertain" && knownRevision === undefined && next.attempt.state !== "submitted") delete next.revision;
            if (JSON.stringify(next) !== JSON.stringify(record)) {
                records.set(hash, next);
                if (next.revision !== undefined) snapshotRevisions.set(next.attempt, next.revision);
                refreshSnapshot(); checkRestoredProof(hash, previous);
            }
        }
    }
    return records.get(hash)?.attempt;
}
export function getPendingWalletAttempts() {
    load();
    return [...records].filter(([hash, record]) => (record.attempt.state === "uncertain" || (record.attempt.state === "submitted" && !walletAttemptIsConfirmed(hash, record.attempt))) && typeof record.invoice === "string")
        .map(([paymentHash, record]) => ({ paymentHash, ...record }));
}
/** Durable state may resolve known older snapshots, never unknown evidence. */
function mergeDurable(hash: string, durable: AttemptRecord | undefined, local: AttemptRecord | undefined) {
    const resolvedNewer = durable && (!local || local.revision !== undefined) && local?.attempt.state !== "submitted" &&
        (durable.revision ?? 0) > (local?.revision ?? 0);
    const merged = resolvedNewer ? durable : protect(durable, local, hash);
    if (merged && local?.revision === undefined && local?.attempt.state === "uncertain" && merged.attempt.state !== "submitted") {
        const unknown = { ...merged };
        delete unknown.revision;
        return unknown;
    }
    return merged;
}
const sameRecord = (left: AttemptRecord | undefined, right: AttemptRecord | undefined) => JSON.stringify(left) === JSON.stringify(right);
const changed = () => new Error("The wallet attempt changed. Review its current status before continuing.");

/** Facts can arrive even from an action which loses the lock. Their import is
 * monotonic, never a resolution or permission to send. Reconcile again if new
 * local evidence arrived while the transaction was committing.
 */
async function reconcileAttempt(hash: string, invoice?: string, amountMsats?: number): Promise<AttemptRecord | undefined> {
    for (;;) {
        let observed: AttemptRecord | undefined;
        const saved = parseRecord(await store.changeWalletAttempt(hash, raw => {
            observed = records.get(hash);
            const authoritative = parseRecord(raw);
            const merged = mergeDurable(hash, authoritative, observed);
            if (!merged) return undefined;
            const next = { ...merged, ...(invoice ? { invoice } : {}), ...(amountMsats === undefined ? {} : { amountMsats }) };
            return sameRecord(next, authoritative) ? authoritative : { ...next, revision: (authoritative?.revision ?? 0) + 1 };
        }));
        const local = records.get(hash);
        const next = local === observed ? saved : mergeDurable(hash, saved, local);
        if (next) remember(hash, next);
        if (sameRecord(next, saved)) { persistent = true; return saved; }
    }
}

export interface LockedWalletAttempt {
    readonly attempt: WalletAttempt | undefined;
    save(attempt: WalletAttempt): Promise<void>;
    refresh(): Promise<void>;
    /** Synchronous guard after the final await, immediately before wire send. */
    isCurrent(attempt: WalletAttempt | undefined): boolean;
}
async function requestWalletLock<T>(hash: string, action: (lock: Lock | null) => Promise<T>): Promise<T> {
    // Firefox reports rejected lock callbacks as unhandled even when the caller
    // catches request(). Keep the failure as a value until the lock is released.
    const outcome = await navigator.locks.request(`holoboard-wallet-payment:${hash}`, { mode: "exclusive", ifAvailable: true }, async lock => {
        try { return { ok: true as const, value: await action(lock) }; }
        catch (error) { return { ok: false as const, error }; }
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
}
/** Shared by send/check and destructive invoice operations. Never queue actions. */
export async function withWalletAttemptLocks<T>(hashes: string[], action: () => Promise<T>): Promise<T> {
    if (typeof navigator === "undefined" || !navigator.locks?.request) throw blocked();
    const keys = [...new Set(hashes)].sort();
    const acquire = async (index: number): Promise<T> => index === keys.length ? action() :
        requestWalletLock(keys[index], async lock => {
            if (!lock) throw new Error("This payment already has a send or status check in progress in another view or tab.");
            return acquire(index + 1);
        });
    return acquire(0);
}
/** Validate the authoritative transaction snapshot as well as local barriers. */
export function walletAttemptBlocksRemoval(hash: string, raw: unknown): boolean {
    load();
    if (invalid.has(hash) || unreadableLegacy) return true;
    const record = mergeDurable(hash, parseRecord(raw), records.get(hash));
    return !!record && record.attempt.state !== "unpaid";
}

/** ifAvailable never queues a send to run after the user's original action. */
export async function withWalletAttempt<T>(hash: string, previous: WalletAttempt | undefined, invoice: string | undefined, amountMsats: number | undefined,
    action: (locked: LockedWalletAttempt) => Promise<T>): Promise<T> {
    load();
    if (!validHash(hash)) throw new Error("Invalid payment hash. No wallet payment was sent.");
    if (previous && !validWalletAttempt(previous)) throw new Error("The previous wallet attempt is malformed or unknown.");
    if (previous) getWalletAttempt(hash, previous);
    const prepare = async () => {
        await initializeWalletAttempts();
        if (previous?.state === "submitted") { await verifyWalletPaymentProof(hash, previous.preimage); getWalletAttempt(hash, previous); }
        if (invalid.has(hash) || unreadableLegacy) throw new Error("The stored wallet attempt cannot be read safely. Check the original wallet before continuing.");
    };
    const readonly = async (failure: unknown) => {
        await prepare();
        persistent = false; notify();
        return action({ get attempt() { return records.get(hash)?.attempt; }, save: async () => { throw failure; },
            refresh: async () => { throw failure; }, isCurrent: () => false });
    };
    if (typeof navigator === "undefined" || !navigator.locks?.request) return readonly(blocked());
    return requestWalletLock(hash, async (lock) => {
        if (!lock) {
            // Reject the action, but finish accepting its protective knowledge.
            // This transaction cannot release a barrier held by the active action.
            if (previous && previous.state !== "unpaid") {
                await prepare();
                try { await reconcileAttempt(hash, invoice, amountMsats); channel?.postMessage(null); }
                catch (failure) { persistent = false; notify(); throw failure; }
            }
            throw new Error("This payment already has a send or status check in progress in another view or tab.");
        }
        await prepare();
        let current: AttemptRecord | undefined;
        try { current = await reconcileAttempt(hash, invoice, amountMsats); }
        catch (failure) {
            persistent = false; notify();
            if (failure instanceof Error && /malformed|unknown/.test(failure.message)) throw failure;
            return readonly(failure);
        }
        if (previous && JSON.stringify(cleanAttempt(previous)) === JSON.stringify(current?.attempt)) snapshotRevisions.set(previous, current?.revision ?? 0);
        const locked: LockedWalletAttempt = {
            get attempt() { return current?.attempt; },
            refresh: async () => { current = await reconcileAttempt(hash, invoice, amountMsats); },
            isCurrent: attempt => !!attempt && snapshotRevisions.get(attempt) === current?.revision &&
                JSON.stringify(attempt) === JSON.stringify(current?.attempt) && sameRecord(current, records.get(hash)),
            save: async (attempt) => {
                if (!validWalletAttempt(attempt)) throw new Error("Invalid wallet attempt.");
                const next: AttemptRecord = { attempt: cleanAttempt(attempt), ...(invoice ? { invoice } : {}), ...(amountMsats === undefined ? {} : { amountMsats }) };
                let observed: AttemptRecord | undefined, conflict = false;
                try {
                    const saved = parseRecord(await store.changeWalletAttempt(hash, raw => {
                        const authoritative = parseRecord(raw);
                        observed = records.get(hash);
                        const latest = mergeDurable(hash, authoritative, observed);
                        conflict = !sameRecord(authoritative, current) || !sameRecord(latest, current);
                        // A resolution belongs to precisely the fact that was checked.
                        // New evidence, including unknown uncertainty, invalidates it.
                        if (conflict) return latest ? { ...protect(latest, next, hash), revision: (authoritative?.revision ?? 0) + 1 } : undefined;
                        if (authoritative?.attempt.state === "submitted" && attempt.state !== "submitted") throw new Error("A submitted payment cannot be released.");
                        return { ...current, ...next, revision: (authoritative?.revision ?? 0) + 1 };
                    }));
                    const local = records.get(hash);
                    const adopted = local === observed ? saved : mergeDurable(hash, saved, local);
                    if (adopted) remember(hash, adopted);
                    current = saved;
                    if (!sameRecord(adopted, saved)) { conflict = true; current = await reconcileAttempt(hash, invoice, amountMsats); }
                    persistent = true; channel?.postMessage(null);
                } catch (failure) {
                    // A failed proof/checkpoint write is still protective knowledge.
                    const protectedRecord = protect(records.get(hash), next, hash);
                    if (protectedRecord) remember(hash, protectedRecord);
                    persistent = false; notify(); throw failure;
                }
                if (conflict && !(attempt.state === "submitted" && current?.attempt.preimage === attempt.preimage && walletAttemptIsConfirmed(hash, current?.attempt))) throw changed();
                snapshotRevisions.set(attempt, current?.revision ?? 0);
            },
        };
        return action(locked);
    });
}
/** Import/proof writes cannot release an existing protective state. */
export async function saveWalletAttempt(hash: string, attempt: WalletAttempt, invoice?: string, amountMsats?: number): Promise<void> {
    await withWalletAttempt(hash, attempt, invoice, amountMsats, async locked => {
        const protectedAttempt = protect(locked.attempt ? { attempt: locked.attempt } : undefined, { attempt }, hash)!.attempt;
        await locked.save(protectedAttempt);
    });
}
/** Only explicit acknowledgement under the same hash lock releases uncertainty. */
export async function acknowledgeWalletFailure(hash: string, previous: WalletAttempt): Promise<WalletAttempt> {
    return withWalletAttempt(hash, previous, undefined, undefined, async locked => {
        if (locked.attempt?.state === "uncertain") await locked.save({ state: "unpaid", walletId: locked.attempt.walletId });
        return locked.attempt!;
    });
}
