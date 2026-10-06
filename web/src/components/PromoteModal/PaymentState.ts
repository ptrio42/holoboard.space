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
    note: string; board: PromoteInvoice; author?: AuthorInvoice;
    tipStatus: "pending" | "confirmed" | "reported";
    promotionPaid: boolean; added: number; authorShare: number;
    publicZap?: boolean; notificationRequested?: boolean;
    billboardApplied?: boolean; feeConverted?: boolean;
    boardAttempt?: WalletAttempt; authorAttempt?: WalletAttempt;
    draft?: PromotionDraft;
}

export function restartBlocked(payment: PromotionPayment): string | null {
    if (payment.promotionPaid || payment.tipStatus !== "pending") return "A part is already paid or marked paid. Keep this session to finish the remaining part.";
    if ([payment.boardAttempt, payment.authorAttempt].some((attempt) => attempt && attempt.state !== "unpaid")) {
        return "Check the unresolved wallet payment before restarting. Sent and uncertain attempts stay protected, even after expiry.";
    }
    return null;
}
