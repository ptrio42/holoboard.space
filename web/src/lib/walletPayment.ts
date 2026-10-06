import { isMockInvoice, MOCK_INVOICE_MESSAGE } from "./invoice";
import { acquireWalletAttempt, getWalletAttempt, saveWalletAttempt } from "./walletAttempts";

export interface WalletProof { preimage?: string; feesPaidMsats?: number }
export interface WalletLookup extends WalletProof { state: "paid" | "unpaid" | "pending" | "unknown" }
export interface PaymentWallet {
    id: string;
    kind: "nwc" | "webln";
    enable(): Promise<void>;
    sendPayment(invoice: string, amountMsats?: number): Promise<WalletProof>;
    lookupPayment?(paymentHash: string): Promise<WalletLookup>;
}
export interface WalletAttempt extends WalletProof {
    state: "unpaid" | "uncertain" | "submitted";
    walletId: string;
}
export class PaymentRejected extends Error {}

export function canPayOrCheckInvoice(wallet: PaymentWallet, expiresAt: number, previous?: WalletAttempt, now = Date.now()): boolean {
    if (previous?.state === "submitted") return !!previous.preimage || (previous.walletId === wallet.id && !!wallet.lookupPayment);
    if (previous?.state === "uncertain") return previous.walletId === wallet.id && !!wallet.lookupPayment;
    return now < expiresAt*1000;
}

/** Persist the attempt before sending, so leaving the page cannot erase it. */
export async function payInvoiceSafely(
    wallet: PaymentWallet, invoice: string, paymentHash: string,
    previous: WalletAttempt | undefined, save: (attempt: WalletAttempt) => void,
    expiresAt = Infinity, amountMsats?: number,
): Promise<WalletProof> {
    if (isMockInvoice(invoice)) throw new PaymentRejected(MOCK_INVOICE_MESSAGE);
    const release = acquireWalletAttempt(paymentHash);
    try {
        const attempt = getWalletAttempt(paymentHash, previous);
        if (attempt && attempt !== previous) save(attempt);
        return await executePayment(wallet, invoice, paymentHash, attempt, (next) => {
            saveWalletAttempt(paymentHash, next, invoice, amountMsats);
            save(next);
        }, expiresAt);
    } finally { release(); }
}

async function executePayment(
    wallet: PaymentWallet, invoice: string, paymentHash: string,
    previous: WalletAttempt | undefined, save: (attempt: WalletAttempt) => void,
    expiresAt = Infinity,
): Promise<WalletProof> {
    if (isMockInvoice(invoice)) throw new PaymentRejected(MOCK_INVOICE_MESSAGE);
    if (previous?.state === "submitted") {
        if (!previous.preimage && previous.walletId === wallet.id && wallet.lookupPayment) {
            const status = await wallet.lookupPayment(paymentHash);
            if (status.state === "paid" && status.preimage) {
                save({ ...previous, preimage: status.preimage });
                return { preimage: status.preimage };
            }
        }
        return { preimage: previous.preimage };
    }
    if (previous?.state === "uncertain") {
        if (previous.walletId !== wallet.id || !wallet.lookupPayment) {
            throw new Error("Payment status is uncertain. Check the original wallet before allowing another attempt.");
        }
        const status = await wallet.lookupPayment(paymentHash);
        if (status.state === "paid") {
            save({ state: "submitted", walletId: wallet.id, preimage: status.preimage });
            return { preimage: status.preimage };
        }
        if (status.state !== "unpaid") {
            throw new Error("The wallet has not confirmed that this payment failed. Check again later or check your wallet before allowing another attempt.");
        }
        // Keep the original wallet's confirmed failure even if expiry prevents
        // another attempt, so the caller can safely replace the invoice.
        save({ state: "unpaid", walletId: wallet.id });
    }
    // Expiry forbids sending, but does not invalidate a saved proof or prevent
    // lookup of an attempt that may have settled before its response was lost.
    if (Date.now() >= expiresAt*1000) throw new Error("The invoice expired. No wallet payment was sent.");
    save({ state: "uncertain", walletId: wallet.id });
    try {
        const proof = await wallet.sendPayment(invoice);
        save({ state: "submitted", walletId: wallet.id, preimage: proof.preimage });
        return proof;
    } catch (failure) {
        if (failure instanceof PaymentRejected) save({ state: "unpaid", walletId: wallet.id });
        throw failure;
    }
}

export async function withTimeout<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([operation, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), milliseconds);
        })]);
    } finally { clearTimeout(timer); }
}
