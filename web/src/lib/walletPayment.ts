import { isMockInvoice, MOCK_INVOICE_MESSAGE } from "./invoice";
import { withWalletAttempt, verifyWalletPaymentProof } from "./walletAttempts";

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
    previous: WalletAttempt | undefined, save: (attempt: WalletAttempt) => unknown | Promise<unknown>,
    expiresAt = Infinity, amountMsats?: number, canSend: () => boolean = () => true, retryUncertain = true,
): Promise<WalletProof> {
    if (isMockInvoice(invoice)) throw new PaymentRejected(MOCK_INVOICE_MESSAGE);
    return withWalletAttempt(paymentHash, previous, invoice, amountMsats, async locked => {
        const attempt = locked.attempt;
        if (attempt && JSON.stringify(attempt) !== JSON.stringify(previous)) await save(attempt);
        return executePayment(wallet, invoice, paymentHash, attempt, async next => {
            await locked.save(next);
            if (await save(next) === false) throw new Error("Private payment storage did not commit. Use Invoice / QR or check the original wallet.");
        }, expiresAt, canSend, retryUncertain);
    });
}

async function executePayment(
    wallet: PaymentWallet, invoice: string, paymentHash: string,
    previous: WalletAttempt | undefined, save: (attempt: WalletAttempt) => unknown | Promise<unknown>,
    expiresAt = Infinity, canSend: () => boolean = () => true, retryUncertain = true,
): Promise<WalletProof> {
    if (isMockInvoice(invoice)) throw new PaymentRejected(MOCK_INVOICE_MESSAGE);
    if (previous?.state === "submitted") {
        if (await verifyWalletPaymentProof(paymentHash, previous.preimage)) return { preimage: previous.preimage };
        if (previous.walletId === wallet.id && wallet.lookupPayment) {
            const status = await wallet.lookupPayment(paymentHash);
            if (status.state === "paid" && await verifyWalletPaymentProof(paymentHash, status.preimage)) {
                await save({ ...previous, preimage: status.preimage });
                return { preimage: status.preimage };
            }
        }
        throw new Error("The wallet reported this payment as sent, but its proof is not verified. Check the original wallet. Another payment will not be sent.");
    }
    if (previous?.state === "uncertain") {
        if (previous.walletId !== wallet.id || !wallet.lookupPayment) {
            throw new Error("Payment status is uncertain. Check the original wallet before allowing another attempt.");
        }
        const status = await wallet.lookupPayment(paymentHash);
        if (status.state === "paid") {
            if (!await verifyWalletPaymentProof(paymentHash, status.preimage)) throw new Error("The wallet did not provide a valid payment proof. Check its history.");
            await save({ state: "submitted", walletId: wallet.id, preimage: status.preimage });
            return { preimage: status.preimage };
        }
        if (status.state !== "unpaid") {
            throw new Error("The wallet has not confirmed that this payment failed. Check again later or check your wallet before allowing another attempt.");
        }
        // Keep the original wallet's confirmed failure even if expiry prevents
        // another attempt, so the caller can safely replace the invoice.
        await save({ state: "unpaid", walletId: wallet.id });
        if (!retryUncertain) throw new Error("The wallet confirmed failure. Use a separate Send action to retry.");
    }
    // Expiry forbids sending, but does not invalidate a saved proof or prevent
    // lookup of an attempt that may have settled before its response was lost.
    if (Date.now() >= expiresAt*1000) throw new Error("The invoice expired. No wallet payment was sent.");
    if (!canSend()) throw new Error("Payment action ended. No wallet payment was sent.");
    await save({ state: "uncertain", walletId: wallet.id });
    if (!canSend()) throw new Error("Payment action ended. Check the original wallet before retrying.");
    if (Date.now() >= expiresAt*1000) throw new Error("The invoice expired. No wallet payment was sent.");
    try {
        const proof = await wallet.sendPayment(invoice);
        if (!await verifyWalletPaymentProof(paymentHash, proof.preimage)) throw new Error("The wallet did not provide a valid payment proof. Check its history.");
        await save({ state: "submitted", walletId: wallet.id, preimage: proof.preimage });
        return proof;
    } catch (failure) {
        if (failure instanceof PaymentRejected) await save({ state: "unpaid", walletId: wallet.id });
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
