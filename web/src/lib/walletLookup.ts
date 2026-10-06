import type { NWCClient } from "@getalby/sdk/nwc";
import { withTimeout, type WalletLookup } from "./walletPayment";

/** Lookup permission is independent of permission to send payments. */
export async function lookupWalletPayment(client: NWCClient, paymentHash: string): Promise<WalletLookup> {
    try {
        const transaction = await withTimeout(client.lookupInvoice({ payment_hash: paymentHash }), 12000, "Could not check the wallet payment status.");
        if (transaction.payment_hash !== paymentHash || transaction.type !== "outgoing") return { state: "unknown" };
        if (transaction.state === "settled" || transaction.settled_at > 0) return { state: "paid", preimage: transaction.preimage };
        return { state: transaction.state === "failed" ? "unpaid" : "pending" };
    } catch { return { state: "unknown" }; }
}
