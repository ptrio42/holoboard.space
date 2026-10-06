import type { ReactNode } from "react";
import { PixelButton } from "../ui/PixelButton";
import type { PromotionPayment } from "./PaymentState";

export function PromotionPaymentResult({ payment, actualRank, busy, onDone, onAnother, onHelp, footer }: {
    payment: PromotionPayment; actualRank: number | null; busy: boolean;
    onDone: () => void; onAnother: () => void; onHelp: () => void;
    footer: (content: ReactNode) => ReactNode;
}) {
    const reported = payment.author && payment.tipStatus === "reported";
    const actionClass = "promotion-action focus-pixel inline-flex min-h-11 items-center text-cyan-200/75 hover:text-neon-cyan disabled:opacity-40";
    return <>
        <section className="space-y-5 text-sm" aria-label="Promotion result">
            <div className="space-y-3 border-b border-cyan-400/20 pb-5">
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-10 w-10 text-neon-cyan" fill="currentColor">
                    <path d="M2 10h4v4h4v4H6v-4H2zm8 4h4v-4h4V6h4v4h-4v4h-4v4h-4z" />
                </svg>
                <h3 tabIndex={-1} className="promotion-section-title text-neon-cyan">{reported ? "Promotion active" : "Payment complete"}</h3>
                <p className="text-cyan-100/80">Added {payment.added} sats to visibility.</p>
                {actualRank !== null && <p className="text-xs text-cyan-100/60">{actualRank > 0 ? `Current position: #${actualRank}, ${actualRank <= 21 ? "main board" : "waiting room"}.` : "This note is currently inactive."}</p>}
            </div>
            <dl className="space-y-3" aria-label="Payment summary">
                <div className="flex flex-wrap justify-between gap-2" aria-label="Holoboard payment">
                    <dt className="promotion-label text-cyan-100">Holoboard</dt>
                    <dd>{payment.board.amountSats} sats</dd>
                    <dd className="w-full text-xs text-neon-cyan">Payment verified</dd>
                </div>
                {payment.author && <div className="flex flex-wrap justify-between gap-2" aria-label="Author payment">
                    <dt className="promotion-label text-cyan-100">Author</dt>
                    <dd>{payment.author.amount_sats} sats</dd>
                    <dd className={`w-full text-xs ${reported ? "text-cyan-100/70" : "text-neon-cyan"}`}>{reported ? "Marked paid by you, unverified" : "Payment verified"}</dd>
                </div>}
                <div className="flex flex-wrap justify-between gap-2 border-t border-cyan-400/20 pt-3">
                    <dt className="promotion-label text-cyan-100/60">{reported ? "Invoice total" : "Total paid"}</dt>
                    <dd className="text-neon-cyan">{payment.board.amountSats + (payment.author?.amount_sats ?? 0)} sats</dd>
                </div>
            </dl>
            {reported && <p className="text-xs text-cyan-100/70">Author support marked paid by you, not independently verified.</p>}
            {(payment.billboardApplied || payment.feeConverted || payment.notificationRequested) && <div className="space-y-2 text-xs text-cyan-100/70">
                {payment.billboardApplied && <p>Your billboard appearance is active.</p>}
                {payment.feeConverted && <p>Appearance became unavailable. Its fee was added to visibility instead.</p>}
                {payment.notificationRequested && <p>Check your Nostr DMs. Reply YES to the confirmation for one expiry notification.</p>}
            </div>}
        </section>
        {footer(<div className="space-y-2">
            <PixelButton className="w-full min-h-11" variant="accent" onClick={onDone}>Done</PixelButton>
            <div className="flex flex-wrap items-center justify-between gap-x-3">
                <button type="button" className={actionClass} disabled={busy} onClick={onAnother}>Make another payment</button>
                <button type="button" className={actionClass} aria-label="Payment help >" onClick={onHelp}>Help &gt;</button>
            </div>
        </div>)}
    </>;
}
