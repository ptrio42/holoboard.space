const LAST_PAYMENT = "holoboard-last-payment";
const payments = new Map<string, string>();
const removed = new Set<string>();
const unsaved = new Set<string>();
let lastPayment: string | null = null;
let persistent = true;

export const paymentSessionIsPersistent = () => persistent;

export function readPaymentSession(key?: string): string | null {
    try {
        const target = key ?? lastPayment ?? sessionStorage.getItem(LAST_PAYMENT);
        return target && !removed.has(target) ? payments.get(target) ?? sessionStorage.getItem(target) : null;
    } catch {
        persistent = false;
        const target = key ?? lastPayment;
        return target ? payments.get(target) ?? null : null;
    }
}

export function listPaymentSessions(prefix: string): { key: string; value: string }[] {
    const entries = new Map(payments);
    try {
        for (let index = 0; index < sessionStorage.length; index++) {
            const key = sessionStorage.key(index);
            if (!key?.startsWith(prefix) || removed.has(key) || entries.has(key)) continue;
            const value = sessionStorage.getItem(key);
            if (value) entries.set(key, value);
        }
    } catch { persistent = false; }
    return [...entries].filter(([key]) => key.startsWith(prefix) && !removed.has(key)).map(([key, value]) => ({ key, value }));
}

export function savePaymentSession(key: string, value: string, makeCurrent = true): boolean {
    removed.delete(key);
    payments.set(key, value);
    if (makeCurrent) lastPayment = key;
    try {
        sessionStorage.setItem(key, value);
        if (makeCurrent) sessionStorage.setItem(LAST_PAYMENT, key);
        unsaved.delete(key);
        persistent = unsaved.size === 0;
    } catch { unsaved.add(key); persistent = false; }
    return persistent;
}

export function removePaymentSession(key: string) {
    removed.add(key);
    unsaved.delete(key);
    payments.delete(key);
    if (lastPayment === key) lastPayment = null;
    try {
        sessionStorage.removeItem(key);
        if (sessionStorage.getItem(LAST_PAYMENT) === key) sessionStorage.removeItem(LAST_PAYMENT);
    } catch { persistent = false; }
}
