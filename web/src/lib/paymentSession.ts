const LAST_PAYMENT = "holoboard-last-payment";
const payments = new Map<string, string>();
const removed = new Set<string>();
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

export function savePaymentSession(key: string, value: string): boolean {
    removed.delete(key);
    payments.set(key, value);
    lastPayment = key;
    try {
        sessionStorage.setItem(key, value);
        sessionStorage.setItem(LAST_PAYMENT, key);
        persistent = true;
    } catch { persistent = false; }
    return persistent;
}

export function removePaymentSession(key: string) {
    removed.add(key);
    payments.delete(key);
    if (lastPayment === key) lastPayment = null;
    try {
        sessionStorage.removeItem(key);
        if (sessionStorage.getItem(LAST_PAYMENT) === key) sessionStorage.removeItem(LAST_PAYMENT);
    } catch { persistent = false; }
}
