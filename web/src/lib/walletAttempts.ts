import type { WalletAttempt } from "./walletPayment";

interface AttemptRecord { attempt: WalletAttempt; invoice?: string; amountMsats?: number }
const KEY = "holoboard-wallet-attempts";
const records = new Map<string, AttemptRecord>();
const active = new Set<string>();
const listeners = new Set<() => void>();
let loaded = false, persistent = true;
let snapshot: ReadonlyMap<string, WalletAttempt> = new Map();
const refreshSnapshot = () => { snapshot = new Map([...records].map(([hash, record]) => [hash, record.attempt])); };

export const walletAttemptsArePersistent = () => persistent;
export const getWalletAttemptsSnapshot = () => { load(); return snapshot; };
export const subscribeWalletAttempts = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function validWalletAttempt(value: unknown): value is WalletAttempt {
    if (!value || typeof value !== "object") return false;
    const attempt = value as WalletAttempt;
    return ["unpaid", "uncertain", "submitted"].includes(attempt.state) && typeof attempt.walletId === "string" && !!attempt.walletId;
}
function load() {
    if (loaded) return;
    loaded = true;
    try {
        const parsed = JSON.parse(sessionStorage.getItem(KEY) ?? "{}");
        const saved = parsed && typeof parsed === "object" ? parsed : {};
        for (const [hash, record] of Object.entries(saved)) {
            if (record && typeof record === "object" && validWalletAttempt((record as AttemptRecord).attempt)) records.set(hash, record as AttemptRecord);
        }
        // Read older tab sessions too, without erasing their invoices or attempts.
        const retain = (hash: unknown, attempt: unknown, invoice?: string, amountMsats?: number) => {
            if (typeof hash !== "string" || !validWalletAttempt(attempt)) return;
            const existing = records.get(hash);
            if (existing && (existing.attempt.state === "submitted" || (saved[hash] && attempt.state !== "submitted") || attempt.state === "unpaid")) return;
            records.set(hash, { attempt, invoice, amountMsats });
        };
        for (let index = 0; index < sessionStorage.length; index++) {
            const key = sessionStorage.key(index);
            if (!key || (!key.startsWith("holoboard-wallet-activity:") && !key.startsWith("holoboard-payment:"))) continue;
            try {
                const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
                if (key.startsWith("holoboard-wallet-activity:")) {
                    for (const [hash, attempt] of Object.entries(value?.attempts ?? {})) retain(hash, attempt, value.send?.paymentHash === hash ? value.send.invoice : undefined, value.send?.paymentHash === hash ? value.send.amountMsats : undefined);
                } else {
                    retain(value?.board?.paymentHash, value?.boardAttempt, value?.board?.invoice, value?.board?.amountSats * 1000);
                    retain(value?.author?.payment_hash, value?.authorAttempt, value?.author?.invoice, value?.author?.amount_sats * 1000);
                }
            } catch { /* Ignore malformed unrelated tab sessions. */ }
        }
    } catch { persistent = false; }
    refreshSnapshot();
}
export function getWalletAttempt(hash: string, previous?: WalletAttempt): WalletAttempt | undefined {
    load();
    if (!records.has(hash) && previous) { records.set(hash, { attempt: previous }); refreshSnapshot(); }
    return records.get(hash)?.attempt;
}
export function getPendingWalletAttempts() {
    load();
    return [...records].filter(([, record]) => record.attempt.state === "uncertain" && typeof record.invoice === "string")
        .map(([paymentHash, record]) => ({ paymentHash, ...record }));
}
export function saveWalletAttempt(hash: string, attempt: WalletAttempt, invoice?: string, amountMsats?: number) {
    load();
    records.set(hash, { ...records.get(hash), attempt, ...(invoice ? { invoice } : {}), ...(amountMsats === undefined ? {} : { amountMsats }) });
    try { sessionStorage.setItem(KEY, JSON.stringify(Object.fromEntries(records))); }
    catch { persistent = false; }
    refreshSnapshot(); listeners.forEach((listener) => listener());
}
export function acquireWalletAttempt(hash: string): () => void {
    if (active.has(hash)) throw new Error("This payment already has a send or status check in progress.");
    active.add(hash);
    return () => { active.delete(hash); };
}
/** Only an explicit acknowledgement of failure may release an uncertain hash. */
export function acknowledgeWalletFailure(hash: string, previous: WalletAttempt): WalletAttempt {
    const attempt = getWalletAttempt(hash, previous)!;
    if (attempt.state !== "uncertain" || active.has(hash)) return attempt;
    const unpaid: WalletAttempt = { state: "unpaid", walletId: attempt.walletId };
    saveWalletAttempt(hash, unpaid);
    return unpaid;
}
