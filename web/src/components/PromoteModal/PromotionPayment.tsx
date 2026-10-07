import type { ReactNode } from "react";
import { ENABLE_NOSTR_CONNECT } from "../../config";
import { CopyButton } from "../ui/CopyButton";
import { PixelButton, PixelLink } from "../ui/PixelButton";
import { QrCode } from "../ui/QrCode";
import { StatusMessage } from "../ui/StatusMessage";
import { ConnectionSettings } from "./ConnectionSettings";
import { canPayOrCheckInvoice, type PaymentWallet } from "../../lib/walletPayment";
import { isMockInvoice, MOCK_INVOICE_MESSAGE } from "../../lib/invoice";
import { restartBlocked, type PaymentMethod, type PaymentRecipient, type PromotionPayment as Payment } from "./PaymentState";

export function PromotionPayment({ id, payment, method, recipient, onRecipient, wallet, walletName, connecting, busy, walletPart, now,
    canResume, error, actualRank, onPay, onReplaceAuthor, onReplaceBoard, onReportAuthor, onAcknowledge, onHelp, onSigner, onRestart, onBack,
    restartConfirm, onRestartConfirm, hasPublicZapConsent, authorCanReplace, footer }: {
    id: string; payment: Payment; method: PaymentMethod; recipient: PaymentRecipient; onRecipient: (part: PaymentRecipient) => void;
    wallet: PaymentWallet | undefined; walletName: string; connecting: boolean; busy: boolean; now: number;
    walletPart: PaymentRecipient | null;
    canResume: boolean; error: string; actualRank: number | null;
    onPay: () => void; onReplaceAuthor: () => void; onReplaceBoard: () => void; onReportAuthor: () => void; onAcknowledge: (part: PaymentRecipient) => void;
    onHelp: () => void; onSigner: () => void; onRestart: () => void; onBack: () => void; restartConfirm: boolean;
    onRestartConfirm: (value: boolean) => void; hasPublicZapConsent: boolean; authorCanReplace: boolean; footer: (content: ReactNode) => ReactNode;
}) {
    const mockPayment = isMockInvoice(payment.board.invoice);
    const parts = [
        { id: "board" as const, label: "Holoboard visibility", amount: payment.board.amountSats, invoice: payment.board.invoice,
            hash: payment.board.paymentHash, expires: payment.board.expiresAt, paid: payment.promotionPaid, reported: false, attempt: payment.boardAttempt },
        ...(payment.author ? [{ id: "author" as const, label: "Support the original author", amount: payment.author.amount_sats, invoice: payment.author.invoice,
            hash: payment.author.payment_hash, expires: payment.author.expires_at, paid: payment.tipStatus !== "pending", reported: payment.tipStatus === "reported", attempt: payment.authorAttempt }] : []),
    ];
    const selected = parts.find((part) => part.id === recipient) ?? parts[0];
    const next = parts.find((part) => !part.paid && part.id !== selected.id && !isMockInvoice(part.invoice));
    const actionable = !mockPayment && wallet ? parts.filter((part) => !part.paid && canPayOrCheckInvoice(wallet, part.expires, part.attempt, now)) : [];
    const chargeable = actionable.filter((part) => part.attempt?.state !== "submitted" && now < part.expires * 1000);
    const charge = chargeable.reduce((sum, part) => sum + part.amount, 0);
    const checking = actionable.some((part) => part.attempt?.state === "uncertain" || part.attempt?.state === "submitted");
    const walletLabel = charge === 0 ? "Check payment status" : checking ? `Check & pay up to ${charge} sats` : `Pay ${charge} sats`;
    const verifying = parts.filter((part) => !part.paid && part.attempt?.state === "submitted");
    const progress = busy ? walletPart ? `Processing ${walletPart === "board" ? "visibility" : "author support"}` : "Processing payment"
        : verifying.length ? `Verifying ${verifying.map((part) => part.id === "board" ? "visibility" : "author support").join(" and ")}` : "";
    const blocked = restartBlocked(payment);
    const invoiceAvailable = !selected.paid && now < selected.expires * 1000 && !isMockInvoice(selected.invoice);
    const actionClass = "promotion-action focus-pixel inline-flex min-h-11 items-center text-cyan-200/75 hover:text-neon-cyan disabled:opacity-40";
    return <>
        <div className="space-y-4 text-sm" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${method}`} tabIndex={0}>
            <p className="truncate text-xs text-cyan-100/60" title={payment.noteSummary}>For: {payment.noteSummary || payment.draft?.config.text || `note ${payment.board.noteId.slice(0, 8)}...${payment.board.noteId.slice(-6)}`}</p>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="promotion-label text-cyan-100/60">Promotion total</span>
                <span className="text-neon-cyan">{parts.reduce((sum, part) => sum + part.amount, 0)} sats</span>
            </div>
            <div className="space-y-2" aria-label="Payment recipients">
                {parts.map((part) => <button key={part.id} type="button" aria-pressed={recipient === part.id}
                    className={`focus-pixel flex min-h-14 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 border-2 px-3 py-2 text-left ${recipient === part.id ? "border-neon-cyan/70 bg-cyan-400/5" : "border-cyan-400/20"}`}
                    onClick={() => onRecipient(part.id)}>
                    <span className="promotion-label text-cyan-100">{part.id === "board" ? "Holoboard" : "Author"}</span>
                    <span>{part.amount} sats</span>
                    <span className={`w-full text-xs ${part.paid || part.attempt?.state === "submitted" ? "text-neon-cyan" : "text-cyan-100/60"}`}>
                        {part.reported ? "Marked paid by you, unverified" : part.paid ? "Payment verified" : part.attempt?.state === "submitted" || walletPart === part.id ? <span aria-hidden="true">&nbsp;</span> : part.attempt?.state === "uncertain" ? "Wallet confirmation missing" : now >= part.expires*1000 ? "Invoice expired" : "Awaiting payment"}
                    </span>
                </button>)}
            </div>
            {progress && <StatusMessage loading compact iconOnly>{progress}</StatusMessage>}
            {mockPayment && <p role="alert" className="text-xs text-neon-gold">{MOCK_INVOICE_MESSAGE} The saved author invoice is separate; check its payment status before starting again.</p>}
            {!canResume && <p className="text-xs text-neon-gold">This browser cannot save the payment for a refresh. Keep the invoices and check your wallet before refreshing or closing this tab.</p>}
            {payment.promotionPaid && <div className="space-y-1 text-xs text-cyan-100/70" aria-live="polite">
                <p className="text-neon-cyan">Added {payment.added} sats to visibility.</p>
                {payment.billboardApplied && <p>Your billboard appearance is active.</p>}
                {payment.feeConverted && <p>Appearance became unavailable. Its fee was added to visibility instead.</p>}
                {payment.notificationRequested && <p>Check your Nostr DMs. Reply YES to the confirmation for one expiry notification.</p>}
                {actualRank !== null && <p>{actualRank > 0 ? `Current position: #${actualRank}, ${actualRank <= 21 ? "main board" : "waiting room"}.` : "This note is currently inactive."}</p>}
            </div>}
            {method === "invoice" ? <section className="space-y-3" aria-label={selected.label}>
                {invoiceAvailable && <>
                    {parts.length > 1 && <p className="promotion-label text-center text-cyan-100/70">Invoice {selected.id === "board" ? 1 : 2} of {parts.length}: {selected.id === "board" ? "Holoboard" : "Author"}</p>}
                    <p className="text-xs text-center text-cyan-100/60">Scan with any Lightning wallet. No account required.</p>
                    {selected.id === "author" && <p className="text-xs text-cyan-100/60">{payment.publicZap ? "Waiting for the author's wallet to publish a zap receipt. Confirmation may be delayed." : "This author invoice has no automatic confirmation here. Check the payment in your wallet, then mark it paid below. Your report remains unverified."}</p>}
                    <div className="flex justify-center"><QrCode key={selected.hash} value={selected.invoice} label={`${selected.label} invoice QR code`} /></div>
                    <details className="disclosure"><summary className={`${actionClass} cursor-pointer`}>Invoice text</summary>
                        <p className="break-all select-all text-xs text-cyan-100/70">{selected.invoice}</p>
                    </details>
                </>}
                {selected.paid && <p className="text-xs text-neon-cyan">{selected.reported ? "Author support marked paid by you, not independently verified." : `${selected.label}: payment verified.`}</p>}
                {selected.paid && next && <PixelButton variant="ghost" onClick={() => onRecipient(next.id)}>Next invoice: {next.id === "author" ? "Author" : "Holoboard"}</PixelButton>}
            </section> : <section className="space-y-3" aria-label="Payment wallet">
                <p className="text-cyan-100">{connecting ? "Connecting wallet..." : wallet ? wallet.kind === "nwc" ? `NWC: ${walletName || "Connected wallet"}` : "Browser wallet (WebLN)" : "Connect NWC to pay here"}</p>
                <p className="text-xs text-cyan-100/60">{wallet ? "Pay sends the remaining parts in sequence. Verified parts are kept." : "You can also pay with any Lightning wallet in Invoice / QR."}</p>
                {wallet?.kind === "nwc" || walletName ? <details className="disclosure"><summary className={`${actionClass} cursor-pointer`}>Wallet settings</summary><ConnectionSettings section="wallet" embedded paymentOnly disabled={busy} /></details> : wallet?.kind === "webln" ? <details className="disclosure"><summary className={`${actionClass} cursor-pointer`}>Connect NWC wallet</summary><ConnectionSettings section="wallet" embedded paymentOnly disabled={busy} /></details> : <ConnectionSettings section="wallet" embedded paymentOnly disabled={busy} />}
                {!wallet && walletName && !connecting && <p className="text-xs text-neon-gold">This NWC connection has no sending permission. Use Invoice / QR or connect a wallet with sending enabled.</p>}
            </section>}
            {parts.map((part) => !part.paid && !isMockInvoice(part.invoice) && <div key={part.id} className="space-y-2 text-xs text-cyan-100/70">
                {part.attempt?.state === "uncertain" && !busy && <>
                    <div role="status" className="space-y-2 border-l-2 border-neon-gold/50 bg-white/[0.03] p-3">
                        <p className="promotion-label text-neon-gold">{part.id === "board" ? "Holoboard" : "Author"} payment not confirmed</p>
                        <p>Your wallet did not confirm the {part.amount} sats {part.id === "board" ? "for Holoboard visibility" : "for the note's author"}. The payment may have succeeded. Look for this amount in your wallet's payment history before paying again.</p>
                        {part.id === "author" && payment.promotionPaid && <p>Your Holoboard visibility payment is already confirmed.</p>}
                        <p>{wallet?.id === part.attempt.walletId && wallet.lookupPayment ? "The Wallet action checks the original wallet before retrying. It only sends again if that wallet confirms a failure." : "Reconnect the wallet used for this payment to check it here, or check its history yourself."}</p>
                    </div>
                    <PixelButton size="sm" variant="ghost" disabled={busy} onClick={() => onAcknowledge(part.id)}>I checked my wallet: {part.id === "board" ? "visibility" : "author support"} was not paid</PixelButton>
                </>}
                {!busy && now >= part.expires * 1000 && (part.id === "board" ? <>
                    <p>The visibility invoice expired. We still check for a delayed confirmation. Check your wallet before starting another payment.</p>
                    {blocked && <PixelButton size="sm" variant="ghost" disabled={busy || (!!part.attempt && part.attempt.state !== "unpaid")} onClick={onReplaceBoard}>Replace visibility invoice after checking wallet</PixelButton>}
                </> : <>
                    <p>The author invoice expired. Check your wallet before replacing it. The visibility payment stays unchanged.</p>
                    {payment.publicZap && !hasPublicZapConsent && <p>Public zap consent ended with the previous signer session. A replacement will use an ordinary author invoice.</p>}
                    <PixelButton size="sm" variant="ghost" disabled={busy || !authorCanReplace || (!!part.attempt && part.attempt.state !== "unpaid")} onClick={onReplaceAuthor}>Replace author invoice after checking wallet</PixelButton>
                </>)}
            </div>)}
            {payment.author && payment.tipStatus === "pending" && method === "invoice" && recipient === "author" && <div className="space-y-2 text-xs text-cyan-100/60">
                <PixelButton size="sm" variant="ghost" disabled={busy} onClick={onReportAuthor}>I paid the author, checked my wallet</PixelButton>
            </div>}
            {ENABLE_NOSTR_CONNECT && payment.publicZap && <button type="button" className={actionClass} disabled={busy} onClick={onSigner}>Nostr signer settings &gt;</button>}
            {error && !busy && <p role="alert" className="text-xs text-neon-pink">{error}</p>}
            {blocked && !busy && <p className="text-xs text-cyan-100/60">{blocked}</p>}
        </div>
        {footer(<div className="space-y-2">
            {method === "wallet" ? wallet && <PixelButton className="w-full min-h-11" variant="accent" disabled={busy || connecting || !actionable.length} onClick={onPay}>
                {walletLabel}
            </PixelButton> : invoiceAvailable && <div className="flex flex-wrap items-stretch gap-2">
                <PixelLink className="min-h-11 flex-1" size="sm" variant="accent" href={`lightning:${selected.invoice}`}>Open in wallet</PixelLink>
                <CopyButton key={selected.hash} value={selected.invoice} label="Copy invoice" />
            </div>}
            {restartConfirm && !blocked && <div className="space-y-2 text-xs text-neon-gold">
                <p>Check your wallet first. Issued invoices are not cancelled and could still be paid. Restart returns to your promotion choices.</p>
                <PixelButton className="w-full" size="sm" variant="ghost" disabled={busy} onClick={onRestart}>I haven't paid, restart</PixelButton>
            </div>}
            <div className="flex flex-wrap items-center justify-between gap-x-3">
                {blocked || busy ? <button type="button" className={actionClass} onClick={onBack}>Back to promotion</button> : restartConfirm ? <button type="button" className={actionClass} onClick={() => onRestartConfirm(false)}>Keep payment</button> : <button type="button" className={actionClass} onClick={() => onRestartConfirm(true)}>Restart payment</button>}
                <button type="button" className={actionClass} aria-label="Payment help >" onClick={onHelp}>Help &gt;</button>
            </div>
        </div>)}
    </>;
}
