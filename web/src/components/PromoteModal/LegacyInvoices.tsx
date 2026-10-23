import { CopyButton } from "../ui/CopyButton";
import { PixelLink } from "../ui/PixelButton";
import { QrCode } from "../ui/QrCode";
import { isMockInvoice } from "../../lib/invoice";
import type { LegacyPaymentInvoices } from "./paymentRecords";

/** Unverified legacy records are invoice copies, never resumable sessions. */
export function LegacyInvoices({ payments }: { payments: LegacyPaymentInvoices[] }) {
    return <details className="disclosure border border-neon-gold/30 px-3">
        <summary className="promotion-action focus-pixel flex min-h-11 cursor-pointer items-center text-neon-gold before:mr-2">Older invoices</summary>
        <div className="space-y-3 pb-3 text-xs text-cyan-100/70">
            <p role="status">Their original backend cannot be verified. These are the original invoice copies, without payment status checks or automatic recovery. Keep a copy and check your wallet before paying or preparing another payment.</p>
            {!payments.length && <p>The older records could not be read. They remain unchanged in this tab's storage.</p>}
            {payments.map(payment => <div key={`${payment.note}:${payment.board.paymentHash}`} className="space-y-2 border-t border-neon-gold/20 pt-2">
                <p className="truncate text-cyan-100">{payment.noteSummary || `Note ${payment.board.noteId.slice(0, 8)}...${payment.board.noteId.slice(-6)}`}</p>
                {[{ label: "Holoboard", invoice: payment.board.invoice, amount: payment.board.amountSats, hash: payment.board.paymentHash },
                    ...(payment.author ? [{ label: "Author", invoice: payment.author.invoice, amount: payment.author.amount_sats, hash: payment.author.payment_hash }] : [])].map(part =>
                    <details className="disclosure" key={part.hash}>
                        <summary className="promotion-action focus-pixel flex min-h-11 cursor-pointer items-center text-cyan-100 before:mr-2">{part.label}: {part.amount} sats</summary>
                        <div className="space-y-3 pb-3" aria-label={`Older ${part.label} invoice`}>
                            <p className="break-all select-all">{part.invoice}</p>
                            {!isMockInvoice(part.invoice) && <>
                                <QrCode value={part.invoice} label={`Older ${part.label} invoice QR code`} />
                                <PixelLink size="sm" variant="accent" href={`lightning:${part.invoice}`}>Open in wallet</PixelLink>
                            </>}
                            <CopyButton value={part.invoice} label="Copy invoice" />
                        </div>
                    </details>)}
            </div>)}
        </div>
    </details>;
}
