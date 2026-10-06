import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { Event } from "nostr-tools/pure";
import { ndk } from "../../lib/ndk";
import { BillboardEditor } from "./BillboardEditor";
import { initialBillboard, validBillboard, type BillboardConfig } from "../../lib/billboard";
import { PixelButton } from "../ui/PixelButton";
import { CopyButton } from "../ui/CopyButton";
import { QrCode } from "../ui/QrCode";
import { checkProgress, fetchNotePreview, describeFailure, requestInvoice, type NotePreview, type PromoteInvoice } from "../../lib/promote";
import { parseNoteReference, parsePubkey } from "../../lib/nostr";
import { PromotionNotePreview } from "./PromotionNotePreview";
import { HelpContent } from "../Help/HelpContent";
import { ZAP_PRESETS } from "../../config";
import type { RankingTarget } from "../../lib/ranking";
import { PromotionAmountPicker, type AmountSelection } from "./PromotionAmountPicker";
import { PromotionSplit } from "./PromotionSplit";
import { PromotionTabs, type PromotionTab } from "./PromotionTabs";
import { allocatePayment, totalForPromotion, browserSigner, browserWallet, fetchAuthorEndpoint, requestAuthorInvoice, verifyAuthorPayment, type AuthorEndpoint, type AuthorInvoice } from "../../lib/support";
import { ConnectionSettings } from "./ConnectionSettings";
import { useConnections } from "../../hooks/useConnections";
import { canPayOrCheckInvoice, payInvoiceSafely, type WalletAttempt } from "../../lib/walletPayment";
import { paymentSessionIsPersistent, readPaymentSession, removePaymentSession, savePaymentSession } from "../../lib/paymentSession";
import { isMockInvoice, MOCK_INVOICE_MESSAGE } from "../../lib/invoice";

type TipStatus = "pending" | "confirmed" | "reported";
interface Payment {
    note: string; board: PromoteInvoice; author?: AuthorInvoice; tipStatus: TipStatus;
    promotionPaid: boolean; added: number; authorShare: number; publicZap?: boolean; notificationRequested?: boolean; billboardApplied?: boolean; feeConverted?: boolean;
    boardAttempt?: WalletAttempt; authorAttempt?: WalletAttempt;
}
const FIELD = "focus-pixel w-full border-2 border-cyan-400/40 bg-void px-3 py-2 text-base text-cyan-100";
const storageKey = (note: string) => `holoboard-payment:${parseNoteReference(note)?.id ?? note}`;
function savePayment(payment: Payment) {
    return savePaymentSession(storageKey(payment.note), JSON.stringify(payment));
}
function restorePayment(note: string): Payment | null {
    try {
        const saved = readPaymentSession(note ? storageKey(note) : undefined);
        if (!saved) return null;
        const value = JSON.parse(saved) as Payment;
        if (!value.board || typeof value.board.invoice !== "string" || typeof value.board.paymentHash !== "string" || typeof value.note !== "string") return null;
        // A mock visibility invoice can never settle. Keep split sessions because
        // their real author invoice may still need payment reconciliation.
        if (isMockInvoice(value.board.invoice) && !value.author) return null;
        if (value.promotionPaid && (!value.author || value.tipStatus !== "pending")) return null;
        return value;
    } catch { return null; }
}

type Panel = "compose" | "appearance" | "options" | "wallet" | "signer" | "help";

export function DirectPromote({ initialReference = "", currentWeight, rankingTargets, onPaid, initialSection, footerHost, navigationHost, onPresentationChange }: {
    initialReference?: string; currentWeight?: number; rankingTargets: RankingTarget[]; onPaid?: () => void;
    initialSection?: string; footerHost: HTMLDivElement | null; navigationHost: HTMLDivElement | null;
    onPresentationChange: (value: { compact: boolean; boost: boolean; payment: boolean }) => void;
}) {
    const connections = useConnections();
    const navigationId = useId();
    const [panelHistory, setPanelHistory] = useState<Panel[]>(initialSection ? ["compose", "help"] : ["compose"]);
    const panel = panelHistory[panelHistory.length - 1];
    const openPanel = (next: Panel) => setPanelHistory((history) => [...history, next]);
    const closePanel = () => setPanelHistory((history) => history.slice(0, -1));
    const selectTab = (tab: PromotionTab) => setPanelHistory(tab === "compose" ? ["compose"] : ["compose", tab]);
    const [helpSection, setHelpSection] = useState(initialSection ?? "");
    const [changingReference, setChangingReference] = useState(false);
    const [noteExpanded, setNoteExpanded] = useState(false);
    const [payment, setPayment] = useState<Payment | null>(() => restorePayment(initialReference));
    const [reference, setReference] = useState(() => restorePayment(initialReference)?.note ?? initialReference);
    const [amount, setAmount] = useState<number>(ZAP_PRESETS[1]);
    const [amountSelection, setAmountSelection] = useState<AmountSelection>({ mode: "amount", rank: null, custom: false });
    const [authorShare, setAuthorShare] = useState(20);
    const [preview, setPreview] = useState<NotePreview | null>(null);
    const [endpoint, setEndpoint] = useState<AuthorEndpoint | null>(null);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [authorInvoiceError, setAuthorInvoiceError] = useState("");
    const [billboardEnabled, setBillboardEnabled] = useState(false);
    const [config, setConfig] = useState<BillboardConfig>(() => initialBillboard(""));
    const [notifyEnabled, setNotifyEnabled] = useState(false);
    const [notifyPubkey, setNotifyPubkey] = useState("");
    const [publicZapSigner, setPublicZapSigner] = useState<ReturnType<typeof browserSigner>>();
    const [expired, setExpired] = useState(false);
    const [actualRank, setActualRank] = useState<number | null>(null);
    const [now, setNow] = useState(Date.now);
    const [canResume, setCanResume] = useState(paymentSessionIsPersistent);
    const abort = useRef<AbortController | null>(null);
    const paidCallback = useRef(onPaid);
    useEffect(() => { paidCallback.current = onPaid; }, [onPaid]);
    const notified = useRef(false);
    const changeAuthorShare = (share: number) => {
        setAuthorShare(share); setAuthorInvoiceError("");
    };
    const existingCampaign = !!preview && (preview.active || preview.satsPaid > 0);
    const campaignShare = !existingCampaign && endpoint?.reason_code === "no_address" ? 0 : preview?.authorShare ?? 20;
    const split = allocatePayment(amount, authorShare);
    const fee = billboardEnabled ? preview?.billboardFeeSats ?? 0 : 0;
    const boost = preview?.active ?? (initialReference !== "" && (currentWeight ?? 0) > 0);
    const knownWeight = preview?.weight ?? currentWeight ?? 0;
    const invalidTip = split.author > 0 && (!endpoint?.available || split.author < endpoint.min_sats || split.author > endpoint.max_sats);
    // Consent belongs to the selected connection in this form and is never
    // restored from a saved invoice's publicZap flag after a refresh.
    const hasPublicZapConsent = () => !!publicZapSigner && publicZapSigner === browserSigner();
    const usePublicZap = hasPublicZapConsent() && !!endpoint?.allows_nostr;
    const compact = boost && panel === "compose" && !payment;
    const hasTabs = !boost && !payment && (panel === "compose" || panel === "appearance" || panel === "options");
    const tabPanelProps = hasTabs ? { role: "tabpanel", id: `${navigationId}-panel`, "aria-labelledby": `${navigationId}-${panel}`, tabIndex: 0 } : {};
    const navigation = hasTabs && navigationHost ? createPortal(<PromotionTabs id={navigationId} active={panel as PromotionTab}
        onChange={selectTab} disabled={busy} hasNote={!!preview} billboardEnabled={billboardEnabled} notificationsEnabled={notifyEnabled} />, navigationHost) : null;
    useEffect(() => {
        const body = footerHost?.closest('[role="dialog"]')?.querySelector<HTMLElement>("[data-modal-body]");
        if (!body || (panel === "help" && helpSection)) return;
        body.scrollTop = 0;
        if (body.closest('[role="dialog"]')?.querySelector('[role="tablist"]')?.contains(document.activeElement)) return;
        if (panel !== "compose") body.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
        else body.querySelector<HTMLElement>('input:not([disabled]), button:not([disabled]), a[href]')?.focus({ preventScroll: true });
    }, [panel, footerHost, helpSection]);
    useEffect(() => {
        onPresentationChange({ compact, boost, payment: payment !== null });
    }, [compact, boost, payment, onPresentationChange]);
    const openHelp = (section = "") => { setHelpSection(section); openPanel("help"); };
    const targets = rankingTargets.filter((target) => !boost || target.rank < (preview?.rank ?? 1000000));
    const actionClass = "promotion-action focus-pixel inline-flex min-h-11 items-center gap-2 text-cyan-200/75 hover:text-neon-cyan disabled:opacity-40";
    const signerAction = <button type="button" className={actionClass} disabled={busy} onClick={() => openPanel("signer")}>
        {browserSigner() ? "Nostr signer settings" : "Connect Nostr for a public zap"} &gt;
    </button>;
    const paymentOptions = <button type="button" className={actionClass} disabled={busy} onClick={() => openPanel("options")}>Payment options &gt;</button>;
    const footer = (content: ReactNode) => footerHost ? createPortal(content, footerHost) : null;

    useEffect(() => {
        if (!parseNoteReference(reference)) { setPreview(null); setEndpoint(null); return; }
        const controller = new AbortController();
        const timer = window.setTimeout(() => {
            setLoading(true); setError(""); setEndpoint(null);
            void fetchNotePreview(reference, controller.signal).then(async (loaded) => {
                if (controller.signal.aborted) return;
                setPreview(loaded); setConfig(loaded.billboard ?? initialBillboard(loaded.event.content));
                setBillboardEnabled(false); setAuthorShare(loaded.authorShare);
                const saved = restorePayment(loaded.event.id);
                if (saved) setPayment(saved);
                try {
                    const author = await fetchAuthorEndpoint(reference, controller.signal);
                    if (!controller.signal.aborted) {
                        setEndpoint(author);
                        if (author.reason_code === "no_address" && !loaded.active && loaded.satsPaid === 0) setAuthorShare(0);
                    }
                }
                catch { if (!controller.signal.aborted) setEndpoint({ available: false, author: loaded.event.pubkey, reason: "Could not reach the author's wallet. Choose visibility only or try again later.", min_sats: 1, max_sats: 0, allows_nostr: false }); }
            }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(describeFailure(failure)); })
                .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        }, initialReference ? 0 : 350);
        return () => { controller.abort(); window.clearTimeout(timer); };
    }, [reference, initialReference]);
    useEffect(() => () => abort.current?.abort(), []);
    useEffect(() => {
        if (!payment) return;
        setCanResume(savePayment(payment));
    }, [payment]);
    const boardInvoice = payment?.board;
    const promotionPaid = payment?.promotionPaid;
    const authorInvoice = payment?.author;
    const paymentNote = payment?.note;
    const tipStatus = payment?.tipStatus;
    const authorProof = payment?.authorAttempt?.preimage;
    const hasPayment = payment !== null;
    useEffect(() => {
        if (!hasPayment) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [hasPayment]);
    useEffect(() => {
        if (!boardInvoice || promotionPaid || isMockInvoice(boardInvoice.invoice)) return;
        const controller = new AbortController();
        const invoice = boardInvoice;
        let timer: number | undefined;
        let checking = false;
        const tick = async () => {
            if (checking || controller.signal.aborted) return;
            checking = true;
            window.clearTimeout(timer);
            try {
                const progress = await checkProgress(invoice.paymentHash, invoice.noteId, controller.signal);
                if (controller.signal.aborted) return;
                if (progress.settled) {
                    setPayment((current) => current ? { ...current, promotionPaid: true, added: progress.satsPaid, billboardApplied: progress.billboardApplied, feeConverted: progress.feeConverted } : current);
                    return;
                }
                setExpired(Date.now() >= invoice.expiresAt*1000);
            } catch { /* A lost response does not prove that a payment failed. */ }
            finally { checking = false; }
            if (!controller.signal.aborted) timer = window.setTimeout(() => void tick(), 3000);
        };
        const resume = () => { if (document.visibilityState === "visible") void tick(); };
        window.addEventListener("pageshow", resume);
        document.addEventListener("visibilitychange", resume);
        void tick();
        return () => { controller.abort(); window.clearTimeout(timer); window.removeEventListener("pageshow", resume); document.removeEventListener("visibilitychange", resume); };
    }, [boardInvoice, promotionPaid]);
    useEffect(() => {
        if (!boardInvoice || !promotionPaid) return;
        const controller = new AbortController();
        void fetchNotePreview(boardInvoice.noteId, controller.signal).then((loaded) => {
            if (!controller.signal.aborted) {
                setActualRank(loaded.rank); setPreview(loaded); setAuthorShare(loaded.authorShare);
                setConfig(loaded.billboard ?? initialBillboard(loaded.event.content)); setBillboardEnabled(false);
            }
        }).catch(() => {});
        return () => controller.abort();
    }, [boardInvoice, promotionPaid]);
    useEffect(() => {
        if (payment?.promotionPaid && !notified.current) { notified.current = true; paidCallback.current?.(); }
    }, [payment?.promotionPaid]);
    useEffect(() => {
        if (!authorInvoice || !boardInvoice || !paymentNote || tipStatus === "confirmed") return;
        const author = authorInvoice;
        const seen = new Set<string>();
        // Fast wallet confirmation can stop this watcher before NDK flushes a
        // grouped request. Start immediately so no empty request stays queued.
        const sub = ndk.subscribe({ kinds: [9735], "#p": [author.author], "#e": [boardInvoice.noteId], limit: 20 }, { closeOnEose: false, groupable: false });
        sub.on("event", (event: NDKEvent) => {
            if (event.tags.find((tag) => tag[0] === "bolt11")?.[1] !== author.invoice || seen.has(event.id)) return;
            seen.add(event.id);
            void verifyAuthorPayment(paymentNote, author, { receipt: event.rawEvent() as Event }).then((verified) => {
                if (verified) setPayment((current) => current?.author?.payment_hash === author.payment_hash ? { ...current, tipStatus: "confirmed" } : current);
            }).catch(() => {});
        });
        return () => sub.stop();
    }, [authorInvoice, boardInvoice, paymentNote, tipStatus]);
    useEffect(() => {
        if (!authorInvoice || !paymentNote || !authorProof || tipStatus !== "pending" || busy) return;
        let active = true, checking = false;
        const verify = async () => {
            if (!active || checking) return;
            checking = true;
            try {
                if (await verifyAuthorPayment(paymentNote, authorInvoice, { preimage: authorProof }) && active) {
                    setPayment((current) => current?.author?.payment_hash === authorInvoice.payment_hash ? { ...current, tipStatus: "confirmed" } : current);
                }
            } catch { /* The proof remains saved when verification is unavailable. */ }
            finally { checking = false; }
        };
        const resume = () => { if (document.visibilityState === "visible") void verify(); };
        void verify(); window.addEventListener("pageshow", resume); document.addEventListener("visibilitychange", resume);
        return () => { active = false; window.removeEventListener("pageshow", resume); document.removeEventListener("visibilitychange", resume); };
    }, [authorInvoice, paymentNote, authorProof, tipStatus, busy]);

    const start = async (payNow = false) => {
        if (!preview || invalidTip) return;
        const contact = notifyEnabled ? parsePubkey(notifyPubkey) : null;
        if (notifyEnabled && !contact) { setError("Enter a valid npub for the confirmation DM."); selectTab("options"); return; }
        setBusy(true); setError(""); setAuthorInvoiceError(""); abort.current?.abort();
        const controller = new AbortController(); abort.current = controller;
        try {
            // Prepare author support before offering an invoice for visibility.
            let author: AuthorInvoice | undefined;
            if (split.author > 0 && endpoint) {
                try {
                    author = await requestAuthorInvoice(reference, split.author, endpoint, usePublicZap, preview.event.id, controller.signal);
                } catch (failure) {
                    if (!controller.signal.aborted) { setAuthorInvoiceError(describeFailure(failure)); selectTab("compose"); }
                    return;
                }
            }
            const board = await requestInvoice(reference, split.promotion, controller.signal, billboardEnabled ? { billboard: config } : undefined, contact ?? undefined, authorShare);
            if (!controller.signal.aborted) {
                notified.current = false; setExpired(false); setActualRank(null);
                const prepared: Payment = { note: reference, board, author, tipStatus: "pending", promotionPaid: false, added: 0, authorShare, publicZap: usePublicZap, notificationRequested: contact !== null };
                savePayment(prepared); setPayment(prepared); selectTab("compose");
                if (payNow) await payWithWallet(prepared);
            }
        } catch (failure) { if (!controller.signal.aborted) setError(describeFailure(failure)); }
        finally { if (!controller.signal.aborted) setBusy(false); }
    };
    const payWithWallet = async (prepared?: Payment) => {
        const pending = prepared ?? payment;
        const wallet = browserWallet(); if (!wallet || !pending || (!prepared && busy)) return;
        if (isMockInvoice(pending.board.invoice)) { setError(MOCK_INVOICE_MESSAGE); return; }
        setBusy(true); setError("");
        let current = pending;
        const saveAttempt = (part: "boardAttempt" | "authorAttempt", attempt: WalletAttempt) => {
            current = { ...current, [part]: attempt };
            savePayment(current);
            setPayment((latest) => latest ? { ...latest, [part]: attempt } : latest);
        };
        const failures: string[] = [];
        try {
            await wallet.enable();
            if (!pending.promotionPaid) {
                try {
                    const progress = await checkProgress(pending.board.paymentHash, pending.board.noteId);
                    if (progress.settled) {
                        current = { ...current, promotionPaid: true, added: progress.satsPaid, billboardApplied: progress.billboardApplied, feeConverted: progress.feeConverted };
                        savePayment(current); setPayment(current);
                    } else if (canPayOrCheckInvoice(wallet, pending.board.expiresAt, pending.boardAttempt)) {
                        await payInvoiceSafely(wallet, pending.board.invoice, pending.board.paymentHash, pending.boardAttempt, (attempt) => saveAttempt("boardAttempt", attempt), pending.board.expiresAt);
                    }
                } catch (failure) { failures.push(`Visibility: ${describeFailure(failure)}`); }
            }
            if (pending.author && pending.tipStatus === "pending") {
                try {
                    if (canPayOrCheckInvoice(wallet, pending.author.expires_at, pending.authorAttempt)) {
                        const proof = await payInvoiceSafely(wallet, pending.author.invoice, pending.author.payment_hash, pending.authorAttempt, (attempt) => saveAttempt("authorAttempt", attempt), pending.author.expires_at);
                        if (proof.preimage && await verifyAuthorPayment(pending.note, pending.author, { preimage: proof.preimage })) setPayment((current) => current ? { ...current, tipStatus: "confirmed" } : current);
                        else failures.push("The wallet returned no verified payment proof. Check your wallet before retrying author support.");
                    }
                } catch (failure) { failures.push(`Author support: ${describeFailure(failure)}`); }
            }
            if (failures.length) setError(`${failures.join(" ")} Any confirmed part is kept.`);
        } catch (failure) { setError(`${describeFailure(failure)} Any confirmed part is kept. Check your wallet before retrying.`); }
        finally { setBusy(false); }
    };
    const replaceAuthorInvoice = async () => {
        if (!payment?.author || !endpoint?.available || busy || (payment.authorAttempt && payment.authorAttempt.state !== "unpaid")) return;
        setBusy(true); setError("");
        try {
            const publicZap = !!payment.publicZap && hasPublicZapConsent() && endpoint.allows_nostr;
            const author = await requestAuthorInvoice(payment.note, payment.author.amount_sats, endpoint, publicZap, payment.board.noteId);
            setPayment((current) => current ? { ...current, author, authorAttempt: undefined, publicZap } : current);
        } catch (failure) { setError(describeFailure(failure)); }
        finally { setBusy(false); }
    };
    const startAnother = () => {
        if (!payment) return;
        removePaymentSession(storageKey(payment.note));
        setPayment(null); setError(""); setExpired(false); setActualRank(null); notified.current = false;
    };
    const cannotPrepare = busy || loading || !preview || invalidTip || (billboardEnabled && !validBillboard(config, preview.event.content, preview.images));
    const submission = <div className="space-y-2">
        {error && <p role="alert" className="text-sm text-neon-pink">{error}</p>}
        <PixelButton className="w-full min-h-11" variant="accent" disabled={cannotPrepare} onClick={() => void start(!!browserWallet())}>
            {busy ? "Preparing payments" : `${browserWallet() ? "Pay & " : ""}${boost ? "Boost" : "Promote"} ${amount+fee} sats`}
        </PixelButton>
        {browserWallet() && !boost && <button type="button" className="promotion-action focus-pixel min-h-11 w-full text-cyan-200/70" disabled={cannotPrepare} onClick={() => void start()}>Prepare invoices only</button>}
        <div className="flex flex-wrap items-center justify-between gap-x-3">
            {hasTabs ? panel !== "compose" && <button type="button" className={actionClass} disabled={busy} onClick={() => selectTab("compose")}> &lt; Back to promotion</button> : paymentOptions}
            <button type="button" className={actionClass} onClick={() => openHelp()}>Help &gt;</button>
        </div>
    </div>;

    const panelHeading: Record<Exclude<Panel, "compose">, string> = {
        appearance: "Billboard appearance",
        options: "Payment options", wallet: "Payment wallet", signer: "Connect Nostr", help: "Holoboard help",
    };
    const panelBody = <div className="space-y-5" {...tabPanelProps}>
        {panel !== "compose" && <h3 tabIndex={-1} className="promotion-section-title text-neon-pink">{panelHeading[panel]}</h3>}
        <div hidden={panel !== "appearance"}>
            {preview && <BillboardEditor preview={preview} config={config} onChange={setConfig} enabled={billboardEnabled} onEnabledChange={setBillboardEnabled} amount={split.promotion} />}
        </div>
        <div hidden={panel !== "options"} className="space-y-4 text-sm text-cyan-100/80">
            <section aria-label="How to pay" className="space-y-3">
                <h4 className="promotion-label text-neon-cyan">Wallet</h4>
                <p>Open, copy or scan invoices with any Lightning wallet. No connection is required.</p>
                <button type="button" className={actionClass} disabled={busy} onClick={() => openPanel("wallet")}>{browserWallet() ? "Payment wallet settings" : "Connect wallet to pay here"} &gt;</button>
                {boost && browserWallet() && !payment && <PixelButton size="sm" variant="ghost" disabled={cannotPrepare} onClick={() => { closePanel(); void start(); }}>Prepare invoices only</PixelButton>}
            </section>
            {payment?.publicZap && signerAction}
            {!payment && <section aria-label="Notifications" className="space-y-3 border-t border-cyan-400/20 pt-3">
                <h4 className="promotion-label text-neon-cyan">Notifications <span className="text-cyan-100/50">/ optional</span></h4>
                <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={notifyEnabled} disabled={busy} onChange={(event) => { setNotifyEnabled(event.target.checked); setError(""); }} />Send me a confirmation DM</label>
                {notifyEnabled && <><input aria-label="Npub for confirmation" className={FIELD} value={notifyPubkey} onChange={(event) => { setNotifyPubkey(event.target.value); setError(""); }} placeholder="npub1..." /><p>Reply YES to the confirmation DM to receive one expiry notification.</p></>}
                {notifyEnabled && (browserSigner() ? <button type="button" className={actionClass} disabled={busy} onClick={() => setNotifyPubkey(connections.signerPubkey)}>Use connected Nostr identity</button> :
                    <button type="button" className={actionClass} disabled={busy} onClick={() => openPanel("signer")}>Connect Nostr to use your npub &gt;</button>)}
            </section>}
        </div>
        {(panel === "wallet" || panel === "signer") && <ConnectionSettings section={panel} embedded disabled={busy} />}
        {panel === "help" && <HelpContent section={helpSection} />}
    </div>;
    if (panel !== "compose") return <>
        {navigation}
        {panelBody}
        {footer(hasTabs ? submission : <button type="button" className={`${actionClass} w-full justify-center`} disabled={busy} onClick={closePanel}> &lt; Back to {panelHistory[panelHistory.length - 2] !== "compose" ? "settings" : payment ? "payment" : boost ? "boost" : "promotion"}</button>)}
    </>;

    if (payment) {
        const finished = payment.promotionPaid && (!payment.author || payment.tipStatus !== "pending");
        const authorExpired = !!payment.author && payment.tipStatus === "pending" && now >= payment.author.expires_at*1000;
        const boardExpired = !payment.promotionPaid && now >= payment.board.expiresAt*1000;
        const wallet = browserWallet();
        const mockPayment = isMockInvoice(payment.board.invoice);
        const walletActionAvailable = !mockPayment && !!wallet && ((!payment.promotionPaid && canPayOrCheckInvoice(wallet, payment.board.expiresAt, payment.boardAttempt, now)) ||
            (!!payment.author && payment.tipStatus === "pending" && canPayOrCheckInvoice(wallet, payment.author.expires_at, payment.authorAttempt, now)));
        return <div className="space-y-4 text-sm leading-relaxed" aria-live="polite">
            {mockPayment && <p role="alert" className="text-neon-gold">{MOCK_INVOICE_MESSAGE} The saved author invoice is separate; check its payment status before starting again.</p>}
            {!payment.promotionPaid && <p className="text-sm text-cyan-100/75">{payment.author ? "Two recipient invoices. Pay each part separately, or use a connected wallet." : "One visibility invoice."}</p>}
            {!canResume && <p className="text-xs text-neon-gold">This browser cannot save the payment for a refresh. Keep the invoices and check your wallet before refreshing or closing this tab.</p>}
            <p className="promotion-section-title text-neon-gold">{payment.promotionPaid ? `Added ${payment.added} sats to visibility.` : payment.author ? "Pay for visibility and author support" : "Pay for visibility"}</p>
            {payment.promotionPaid && payment.billboardApplied && <p className="text-xs text-neon-cyan">Your billboard appearance is active.</p>}
            {payment.promotionPaid && payment.feeConverted && <p className="text-xs text-neon-gold">Appearance became unavailable. Its fee was added to visibility instead.</p>}
            {payment.promotionPaid && payment.notificationRequested && <p className="text-xs text-cyan-100/70">Check your Nostr DMs. Reply YES to the confirmation for one expiry notification.</p>}
            {actualRank !== null && <p className="text-xs text-cyan-100/70">{actualRank > 0 ? `Current position: #${actualRank}, ${actualRank <= 21 ? "main board" : "waiting room"}.` : "This note is currently inactive."}</p>}
            {!payment.author && !payment.promotionPaid && !mockPayment && <p className="text-xs text-cyan-100/70">Open, copy or scan the visibility invoice. No account is required.</p>}
            <div className="space-y-4">
                {!payment.promotionPaid && !boardExpired && <InvoiceCard title="Holoboard visibility" amount={payment.board.amountSats} invoice={payment.board.invoice} />}
                {payment.author && <div className="space-y-2">
                    <p className="text-xs text-cyan-100/80">Author support: {payment.author.amount_sats} sats, {payment.tipStatus === "confirmed" ? "payment verified" : payment.tipStatus === "reported" ? "marked paid by you, not independently verified" : "awaiting payment confirmation"}.</p>
                    {payment.tipStatus === "pending" && <>
                        {!authorExpired && <InvoiceCard title="Support the original author" amount={payment.author.amount_sats} invoice={payment.author.invoice} />}
                        {authorExpired && <><p className="text-xs text-neon-gold">The author invoice expired. Check your wallet before replacing it. The visibility payment stays unchanged.</p>
                            {payment.publicZap && !hasPublicZapConsent() && <p className="text-xs text-cyan-100/70">Public zap consent ended with the previous signer session. A replacement will use an ordinary author invoice.</p>}
                            <PixelButton size="sm" variant="ghost" disabled={busy || !endpoint?.available || (!!payment.authorAttempt && payment.authorAttempt.state !== "unpaid")} onClick={() => void replaceAuthorInvoice()}>Replace author invoice after checking wallet</PixelButton></>}
                        <p className="text-xs text-cyan-100/60">A manual payment may not send a confirmation here. Check your wallet before trying again.</p>
                        <PixelButton size="sm" variant="ghost" disabled={busy} onClick={() => setPayment({ ...payment, tipStatus: "reported" })}>I paid the author, checked my wallet</PixelButton>
                    </>}
                </div>}
            </div>
            {!finished && paymentOptions}
            {!finished && wallet && footer(<PixelButton className="w-full min-h-11" variant="accent" disabled={busy || connections.walletStatus === "connecting" || !walletActionAvailable} onClick={() => void payWithWallet()}>{busy ? "Waiting for wallet" : wallet.kind === "nwc" ? "Pay remaining parts with NWC wallet" : "Pay remaining parts with browser wallet"}</PixelButton>)}
            {(["board", "author"] as const).map((part) => {
                const attempt = part === "board" ? payment.boardAttempt : payment.authorAttempt;
                if (part === "board" && mockPayment) return null;
                if (!attempt || (part === "board" ? payment.promotionPaid : payment.tipStatus !== "pending")) return null;
                if (attempt.state === "submitted") return <p key={part} className="text-xs text-neon-gold">The wallet reported the {part === "board" ? "visibility" : "author"} payment as sent. Awaiting verification; another wallet payment will not be sent.</p>;
                if (attempt.state !== "uncertain") return null;
                return <div key={part} className="space-y-2 text-xs text-neon-gold">
                    <p>The {part === "board" ? "visibility" : "author"} payment status is uncertain. Check your wallet history. NWC checks the original wallet before retrying.</p>
                    <p>If the wallet still shows a pending payment, wait. Allow another attempt only after confirming that the earlier attempt failed or was cancelled.</p>
                    <PixelButton size="sm" variant="ghost" disabled={busy} onClick={() => {
                        const next = { ...payment, [part === "board" ? "boardAttempt" : "authorAttempt"]: undefined };
                        savePayment(next); setPayment(next); setError("");
                    }}>I checked my wallet: {part === "board" ? "visibility" : "author support"} was not paid</PixelButton>
                </div>;
            })}
            {expired && !payment.promotionPaid && !mockPayment && <p className="text-xs text-neon-gold">The visibility invoice expired. We still check for a delayed confirmation. Check your wallet before starting another payment.</p>}
            {error && <p role="alert" className="text-xs text-neon-pink">{error}</p>}
            {(finished || (expired && !payment.promotionPaid)) && <PixelButton variant="ghost" disabled={busy} onClick={startAnother}>{finished ? "Make another payment" : "Start another payment after checking wallet"}</PixelButton>}
            <p className="text-xs text-cyan-100/50">Author support is paid directly to the author and adds no ranking weight. Paid parts are never automatically charged again.</p>
            <button type="button" className={actionClass} onClick={() => openHelp("payments")}>Payment help &gt;</button>
        </div>;
    }
    return <>{navigation}<div className={boost ? "space-y-2" : "space-y-4"} aria-busy={loading || busy} {...tabPanelProps}>
        {(!preview && !initialReference || changingReference) && <label className="block space-y-2">
            <span className="promotion-label text-cyan-200/70">Note link</span>
            <input className={`${FIELD} min-h-11 text-base`} value={reference} placeholder="note1, nevent1, or a note link" spellCheck={false}
                onChange={(event) => { setReference(event.target.value); setPreview(null); setEndpoint(null); setAuthorInvoiceError(""); setNoteExpanded(false); }} />
        </label>}
        {loading && <p role="status" className="text-sm text-cyan-100/60">Loading note and author payment details...</p>}
        {preview && <PromotionNotePreview preview={preview} compact={boost} expanded={noteExpanded} onToggle={() => setNoteExpanded(!noteExpanded)}>
            {!initialReference && <button type="button" className="promotion-action focus-pixel min-h-11" disabled={busy} onClick={() => setChangingReference(!changingReference)}>{changingReference ? "Done" : "Change note"}</button>}
        </PromotionNotePreview>}
        {!boost && billboardEnabled && <p className="text-xs text-neon-gold">Billboard +{fee} sats, included in the total.</p>}
        <PromotionAmountPicker amount={amount} currentWeight={knownWeight} max={10000000} appearanceFee={fee} targets={targets} disabled={busy}
            selection={amountSelection} onSelectionChange={setAmountSelection} onRankingHelp={() => openHelp("how-ranking-works")}
            totalForPromotion={(needed) => totalForPromotion(needed, authorShare)} onChange={setAmount} />
        <PromotionSplit author={preview?.event.pubkey} authorShare={authorShare} promotionSats={split.promotion} authorSats={split.author} disabled={busy} onChange={changeAuthorShare}>
            <div className="flex flex-wrap items-center justify-between gap-x-3 text-cyan-100/75">
                {authorShare !== campaignShare && <button type="button" className={actionClass} disabled={busy} onClick={() => changeAuthorShare(campaignShare)} aria-label={existingCampaign ? "Use campaign split" : "Use default split"}>
                    <span className="sm:hidden">Reset</span><span className="hidden sm:inline">{existingCampaign ? "Use campaign split" : "Use default split"}</span>
                </button>}
                {endpoint?.allows_nostr && authorShare > 0 && <details className="disclosure">
                    <summary tabIndex={0} className={`${actionClass} cursor-pointer`}>Public author zap{usePublicZap ? " on" : ""}</summary>
                    <div className="space-y-2 text-sm">
                        {browserSigner() && <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={usePublicZap} disabled={busy} onChange={(event) => setPublicZapSigner(event.target.checked ? browserSigner() : undefined)} />Send author support as a public zap (asks your Nostr signer)</label>}
                        {signerAction}
                    </div>
                </details>}
            </div>
        </PromotionSplit>
        {split.author > 0 && (authorInvoiceError || (endpoint && invalidTip)) && <div className="space-y-2 border-l-2 border-neon-gold pl-3 text-sm text-neon-gold">
            <p role="alert">{authorInvoiceError ? `Could not prepare author support: ${authorInvoiceError}` : !endpoint?.available ? endpoint?.reason : `The author's wallet accepts ${endpoint.min_sats} to ${endpoint.max_sats} sats. Increase the amount or change the allocation.`}</p>
            <p>Visibility only would allocate {amount} sats to Holoboard visibility and 0 sats to the author{fee > 0 ? `, plus ${fee} sats for appearance` : ""}. Total: {amount+fee} sats. Review the allocation before preparing an invoice.</p>
            <PixelButton size="sm" variant="ghost" disabled={busy} onClick={() => { changeAuthorShare(0); setError(""); }}>Choose visibility only</PixelButton>
        </div>}
        {footer(submission)}
    </div></>;
}

function InvoiceCard({ title, amount, invoice }: { title: string; amount: number; invoice: string }) {
    if (isMockInvoice(invoice)) return null;
    return <section className="space-y-3 border-2 border-cyan-400/25 p-3">
        <h3 className="promotion-section-title text-neon-cyan">{title}: {amount} sats</h3>
        <a href={`lightning:${invoice}`} className="promotion-action focus-pixel inline-flex min-h-11 items-center text-neon-gold">Open in wallet</a>
        <details className="disclosure"><summary className="promotion-action focus-pixel min-h-11 cursor-pointer text-cyan-300/70">Show QR code</summary><div className="flex justify-center py-3"><QrCode value={invoice} label={`${title} invoice QR code`} /></div></details>
        <CopyButton value={invoice} label="Copy invoice" />
    </section>;
}
