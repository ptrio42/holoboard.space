import type { PromotionPayment } from "./PaymentState";

export function UnfinishedPayments({ payments, forNote, disabled, persistent, onResume }: {
    payments: PromotionPayment[]; forNote: boolean; disabled: boolean; persistent: boolean; onResume: (payment: PromotionPayment) => void;
}) {
    if (!payments.length) return null;
    return <details className="disclosure border border-cyan-400/25 px-3" open={forNote}>
        <summary className="promotion-action focus-pixel flex min-h-11 cursor-pointer items-center text-cyan-100/80 before:mr-2 before:shrink-0 before:whitespace-nowrap">
            {forNote ? "Previous payment for this note" : "Unfinished payments"}
        </summary>
        <div className="space-y-3 pb-3 text-xs text-cyan-100/70">
            {!persistent && <p>Keep this tab open. This browser could not save all invoices for a refresh.</p>}
            <p>Resume to finish the remaining parts. A new payment has its own total. Previous invoices are kept; returning here does not cancel or refund payments.</p>
            {payments.map((payment) => <div key={`${payment.board.noteId}:${payment.board.paymentHash}`} className="space-y-1 border-t border-cyan-400/20 pt-2">
                {!forNote && <p className="truncate text-cyan-100">{payment.noteSummary || payment.draft?.config.text || `Note ${payment.board.noteId.slice(0, 8)}...${payment.board.noteId.slice(-6)}`}</p>}
                <p>Holoboard: {payment.board.amountSats} sats{payment.promotionPaid ? ", verified" : ", not confirmed"}.
                    {payment.author && <> Author: {payment.author.amount_sats} sats{payment.tipStatus === "confirmed" ? ", verified" : payment.tipStatus === "reported" ? ", marked paid by you" : ", not confirmed"}.</>}</p>
                <button type="button" className="promotion-action focus-pixel inline-flex min-h-11 items-center text-neon-cyan disabled:opacity-40" disabled={disabled} onClick={() => onResume(payment)}>Resume payment</button>
            </div>)}
        </div>
    </details>;
}
