import type { Event } from "nostr-tools/pure";
import type { BillboardConfig } from "../../lib/billboard";
import type { PromoteInvoice } from "../../lib/promote";
import type { AuthorInvoice } from "../../lib/support";
import type { WalletAttempt } from "../../lib/walletPayment";
import type { AmountSelection } from "./PromotionAmountPicker";

export type PaymentMethod = "wallet" | "invoice";
export type PaymentRecipient = "board" | "author";
export interface PromotionDraft {
    amount: number;
    amountSelection: AmountSelection;
    authorShare: number;
    billboardEnabled: boolean;
    config: BillboardConfig;
    notifyEnabled: boolean;
    notifyPubkey: string;
}
export interface PromotionPayment {
    recoveryBackend?: { api: string; relayPubkey: string };
    note: string; board: PromoteInvoice; author?: AuthorInvoice;
    tipStatus: "pending" | "confirmed" | "reported";
    promotionPaid: boolean; added: number; authorShare: number;
    publicZap?: boolean; notificationRequested?: boolean;
    billboardApplied?: boolean; feeConverted?: boolean;
    boardAttempt?: WalletAttempt; authorAttempt?: WalletAttempt;
    draft?: PromotionDraft;
    /** Returning to the editor keeps this session available for explicit resume. */
    editing?: boolean;
    noteSummary?: string;
    /** Verified source for reading, distinct from a private root submitted for creation. */
    sourceEvent?: Event;
    /** Private signed root snapshot; never contains the guest secret key. */
    event?: Event;
    publication?: "pending" | "delivered" | "stopped";
}

export function restartBlocked(payment: PromotionPayment): string | null {
    if (payment.promotionPaid || payment.tipStatus !== "pending") return "A part is already paid or marked paid. Back to promotion keeps these invoices available to finish later.";
    if ([payment.boardAttempt, payment.authorAttempt].some((attempt) => attempt && attempt.state !== "unpaid")) {
        return "Back to promotion keeps these invoices and their protection against another wallet charge, even after expiry.";
    }
    return null;
}
