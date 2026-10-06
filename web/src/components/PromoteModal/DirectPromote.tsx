import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
import { parseNoteReference, parsePubkey, njumpUrl } from "../../lib/nostr";
import { UserProfileInline } from "../UserProfileInline/UserProfileInline";
import { CompactNoteText } from "../TextRenderer/CompactNoteText";
import { HelpContent } from "../Help/HelpContent";
import { ZAP_PRESETS } from "../../config";
import type { RankingTarget } from "../../lib/ranking";
import { PromotionAmountPicker } from "./PromotionAmountPicker";
import { allocatePayment, totalForPromotion, browserSigner, browserWallet, fetchAuthorEndpoint, requestAuthorInvoice, verifyAuthorPayment, type AuthorEndpoint, type AuthorInvoice } from "../../lib/support";
import { ConnectionSettings } from "./ConnectionSettings";
import { useConnections } from "../../hooks/useConnections";
import { canPayOrCheckInvoice, payInvoiceSafely, type WalletAttempt } from "../../lib/walletPayment";
import { paymentSessionIsPersistent, readPaymentSession, removePaymentSession, savePaymentSession } from "../../lib/paymentSession";
import { acknowledgeWalletFailure, getWalletAttempt, getWalletAttemptsSnapshot, subscribeWalletAttempts } from "../../lib/walletAttempts";
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

type Panel = "compose" | "allocation" | "appearance" | "ranking" | "notifications" | "wallet" | "signer" | "help";

export function DirectPromote({ initialReference = "", currentWeight, rankingTargets, onPaid, initialSection, footerHost, onPresentationChange }: {
    initialReference?: string; currentWeight?: number; rankingTargets: RankingTarget[]; onPaid?: () => void;
    initialSection?: string; footerHost: HTMLDivElement | null;
    onPresentationChange: (value: { compact: boolean; boost: boolean; payment: boolean }) => void;
}) {
    const connections = useConnections();
    const [panelHistory, setPanelHistory] = useState<Panel[]>(initialSection ? ["compose", "help"] : ["compose"]);
    const panel = panelHistory[panelHistory.length - 1];
    const openPanel = (next: Panel) => setPanelHistory((history) => [...history, next]);
    const closePanel = () => setPanelHistory((history) => history.slice(0, -1));
    const [helpSection, setHelpSection] = useState(initialSection ?? "");
    const [customized, setCustomized] = useState(!initialReference || (currentWeight ?? 0) === 0);
    const [changingReference, setChangingReference] = useState(false);
    const [noteExpanded, setNoteExpanded] = useState(false);
    const [savedPayment, setPayment] = useState<Payment | null>(() => restorePayment(initialReference));
    const attempts = useSyncExternalStore(subscribeWalletAttempts, getWalletAttemptsSnapshot);
    const payment = useMemo(() => savedPayment ? {
        ...savedPayment,
        boardAttempt: attempts.get(savedPayment.board.paymentHash) ?? getWalletAttempt(savedPayment.board.paymentHash, savedPayment.boardAttempt),
        authorAttempt: savedPayment.author ? attempts.get(savedPayment.author.payment_hash) ?? getWalletAttempt(savedPayment.author.payment_hash, savedPayment.authorAttempt) : undefined,
    } : null, [savedPayment, attempts]);
    const [reference, setReference] = useState(() => restorePayment(initialReference)?.note ?? initialReference);
    const [amount, setAmount] = useState<number>(ZAP_PRESETS[1]);
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
    const previousAuthorShare = useRef(20);
    const changeAuthorShare = (share: number) => {
        if (share > 0) previousAuthorShare.current = share;
        setAuthorShare(share); setAuthorInvoiceError("");
    };
    const split = allocatePayment(amount, authorShare);
    const fee = billboardEnabled ? preview?.billboardFeeSats ?? 0 : 0;
    const boost = preview?.active ?? (initialReference !== "" && (currentWeight ?? 0) > 0);
    const knownWeight = preview?.weight ?? currentWeight ?? 0;
    const invalidTip = split.author > 0 && (!endpoint?.available || split.author < endpoint.min_sats || split.author > endpoint.max_sats);
    // Consent belongs to the selected connection in this form and is never
    // restored from a saved invoice's publicZap flag after a refresh.
    const hasPublicZapConsent = () => !!publicZapSigner && publicZapSigner === browserSigner();
    const usePublicZap = hasPublicZapConsent() && !!endpoint?.allows_nostr;
    const compact = boost && !customized && panel === "compose" && !payment;
    useEffect(() => {
        const body = footerHost?.closest('[role="dialog"]')?.querySelector<HTMLElement>("[data-modal-body]");
        if (!body || (panel === "help" && helpSection)) return;
        body.scrollTop = 0;
        if (panel !== "compose") body.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
        else body.querySelector<HTMLElement>('input:not([disabled]), button:not([disabled]), a[href]')?.focus({ preventScroll: true });
    }, [panel, footerHost, helpSection]);
    useEffect(() => {
        onPresentationChange({ compact, boost, payment: payment !== null });
    }, [compact, boost, payment, onPresentationChange]);
    const openHelp = (section = "") => { setHelpSection(section); openPanel("help"); };
    const targets = rankingTargets.filter((target) => !boost || target.rank < (preview?.rank ?? 1000000));
    const actionClass = "promotion-action focus-pixel inline-flex min-h-11 items-center gap-2 text-cyan-200/75 hover:text-neon-cyan disabled:opacity-40";
    const connectionActions = <div className="flex flex-wrap gap-x-5 max-[359px]:gap-x-3">
        <button type="button" className={actionClass} disabled={busy} onClick={() => openPanel("wallet")}>Wallet{connections.walletStatus === "connected" && <span className="h-1.5 w-1.5 bg-neon-gold" aria-label="Connected" />}</button>
        <button type="button" className={actionClass} disabled={busy} onClick={() => openPanel("signer")}>{connections.signerStatus === "connected" ? "Nostr connected" : "Connect Nostr"}</button>
        <button type="button" className={actionClass} disabled={busy} onClick={() => openHelp()}>Help</button>
    </div>;
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
                if (loaded.authorShare > 0) previousAuthorShare.current = loaded.authorShare;
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
        if (notifyEnabled && !contact) { setError("Enter a valid npub for the confirmation DM."); return; }
        setBusy(true); setError(""); setAuthorInvoiceError(""); abort.current?.abort();
        const controller = new AbortController(); abort.current = controller;
        try {
            // Prepare author support before offering an invoice for visibility.
            let author: AuthorInvoice | undefined;
            if (split.author > 0 && endpoint) {
                try {
                    author = await requestAuthorInvoice(reference, split.author, endpoint, usePublicZap, preview.event.id, controller.signal);
                } catch (failure) {
                    if (!controller.signal.aborted) setAuthorInvoiceError(describeFailure(failure));
                    return;
                }
            }
            const board = await requestInvoice(reference, split.promotion, controller.signal, billboardEnabled ? { billboard: config } : undefined, contact ?? undefined, authorShare);
            if (!controller.signal.aborted) {
                notified.current = false; setExpired(false); setActualRank(null);
                const prepared: Payment = { note: reference, board, author, tipStatus: "pending", promotionPaid: false, added: 0, authorShare, publicZap: usePublicZap, notificationRequested: contact !== null };
                savePayment(prepared); setPayment(prepared);
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
    const submission = <div className="space-y-2">
        <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-cyan-100/70">{split.author > 0 ? "2 recipient invoices" : "1 visibility invoice"}</span>
            <strong className="text-neon-gold">Total: {amount + fee} sats</strong>
        </div>
        {fee > 0 && <p className="text-xs text-cyan-100/60">Includes {fee} sats for billboard appearance.</p>}
        {error && <p role="alert" className="text-sm text-neon-pink">{error}</p>}
        <PixelButton className="w-full min-h-11" variant="accent" disabled={busy || loading || !preview || invalidTip || (billboardEnabled && !validBillboard(config, preview.event.content, preview.images))} onClick={() => void start(!!browserWallet())}>
            {busy ? "Preparing payments" : `${browserWallet() ? "Pay & " : ""}${boost ? "Boost" : "Promote"} ${amount+fee} sats`}
        </PixelButton>
        {browserWallet() && <button type="button" className="promotion-action focus-pixel min-h-11 w-full text-cyan-200/70" disabled={busy || loading || !preview || invalidTip || (billboardEnabled && !validBillboard(config, preview.event.content, preview.images))} onClick={() => void start()}>Prepare invoices only</button>}
        <p className="text-xs leading-relaxed text-cyan-100/55">Visibility weight halves every 30 days. Rank is not guaranteed. Spam and scams may be removed without a refund. <button type="button" className="promotion-action focus-pixel text-cyan-200 underline" onClick={() => openHelp("appearance-and-rules")}>Rules</button></p>
    </div>;

    const panelHeading: Record<Exclude<Panel, "compose">, string> = {
        allocation: "Author support", appearance: "Billboard appearance", ranking: "Target position",
        notifications: "Notifications", wallet: "Payment wallet", signer: "Connect Nostr", help: "Holoboard help",
    };
    const panelBody = <div className="space-y-5">
        {panel !== "compose" && <h3 tabIndex={-1} className="promotion-section-title text-neon-pink">{panelHeading[panel]}</h3>}
        <div hidden={panel !== "allocation"} className="space-y-4 text-sm text-cyan-100/80">
            <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={authorShare > 0} disabled={busy} onChange={(event) => changeAuthorShare(event.target.checked ? previousAuthorShare.current : 0)} />Support the author too</label>
            <label className="block space-y-3">
                <span className="flex justify-between gap-3"><span className="promotion-label">Author share</span><output>{authorShare}%</output></span>
                <input aria-label="Author share in percent" type="range" min={0} max={99} step={1} value={authorShare} disabled={busy}
                    className="allocation-slider focus-pixel w-full min-h-11 accent-neon-pink" onChange={(event) => changeAuthorShare(Number(event.target.value))} />
            </label>
            <div className="flex flex-wrap justify-between gap-3"><span>Holoboard visibility: <strong>{split.promotion} sats</strong> ({100-authorShare}%)</span><span>Support the author: <strong>{split.author} sats</strong> ({authorShare}%)</span></div>
            <p className="text-xs leading-relaxed text-cyan-100/60">{preview && (preview.active || preview.satsPaid > 0) ? "Applies to this payment. The campaign's public zap split stays unchanged." : "The first successful promotion fixes this public zap split for the campaign."} Author sats round down; at least 1 sat goes to visibility.</p>
            {endpoint?.allows_nostr && browserSigner() && authorShare > 0 && <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={usePublicZap} disabled={busy} onChange={(event) => setPublicZapSigner(event.target.checked ? browserSigner() : undefined)} />Send author support as a public zap (asks your Nostr signer)</label>}
            {authorShare > 0 && !browserSigner() && <button type="button" className={actionClass} onClick={() => openPanel("signer")}>Connect Nostr for a public zap &gt;</button>}
        </div>
        <div hidden={panel !== "appearance"}>
            {preview && <BillboardEditor preview={preview} config={config} onChange={setConfig} enabled={billboardEnabled} onEnabledChange={setBillboardEnabled} amount={split.promotion} />}
        </div>
        <div hidden={panel !== "ranking"} className="space-y-4">
            <PromotionAmountPicker amount={amount} currentWeight={knownWeight} max={10000000} targets={targets} showHigherTargets disabled={busy}
                totalForPromotion={(needed) => totalForPromotion(needed, authorShare)} onChange={setAmount} />
            {!targets.length && <p className="text-sm text-cyan-100/70">{boost ? "This note is already above the available targets." : "Ranking targets are not available yet. Choose an amount to add visibility."}</p>}
            <button type="button" className={actionClass} onClick={() => openHelp("how-ranking-works")}>How ranking works &gt;</button>
        </div>
        <div hidden={panel !== "notifications"} className="space-y-3 text-sm text-cyan-100/80">
            <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={notifyEnabled} disabled={busy} onChange={(event) => setNotifyEnabled(event.target.checked)} />Send me a confirmation DM</label>
            {notifyEnabled && <><input aria-label="Npub for confirmation" className={FIELD} value={notifyPubkey} onChange={(event) => setNotifyPubkey(event.target.value)} placeholder="npub1..." /><p>Reply YES to the confirmation DM to receive one expiry notification.</p></>}
        </div>
        {(panel === "wallet" || panel === "signer") && <ConnectionSettings section={panel} embedded disabled={busy} />}
        {panel === "help" && <HelpContent section={helpSection} />}
    </div>;
    if (panel !== "compose") return <>
        {panelBody}
        {footer(<button type="button" className={`${actionClass} w-full justify-center`} onClick={closePanel}> &lt; Back to {panelHistory[panelHistory.length - 2] !== "compose" ? "settings" : payment ? "payment" : boost ? "boost" : "promotion"}</button>)}
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
            {connectionActions}
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
                        const hash = part === "board" ? payment.board.paymentHash : payment.author!.payment_hash;
                        const next = { ...payment, [part === "board" ? "boardAttempt" : "authorAttempt"]: acknowledgeWalletFailure(hash, attempt) };
                        savePayment(next); setPayment(next); setError("");
                    }}>I checked my wallet: {part === "board" ? "visibility" : "author support"} was not paid</PixelButton>
                </div>;
            })}
            {expired && !payment.promotionPaid && !mockPayment && <p className="text-xs text-neon-gold">The visibility invoice expired. We still check for a delayed confirmation. Check your wallet before starting another payment.</p>}
            {error && <p role="alert" className="text-xs text-neon-pink">{error}</p>}
            {(finished || (expired && !payment.promotionPaid)) && <PixelButton variant="ghost" disabled={busy} onClick={startAnother}>{finished ? "Make another payment" : "Start another payment after checking wallet"}</PixelButton>}
            <p className="text-xs text-cyan-100/50">Author support is paid directly to the author and adds no ranking weight. Paid parts are never automatically charged again.</p>
        </div>;
    }
    return <div className="space-y-4" aria-busy={loading || busy}>
        {(!preview && !initialReference || changingReference) && <label className="block space-y-2">
            <span className="promotion-label text-cyan-200/70">Note link</span>
            <input className={`${FIELD} min-h-11 text-base`} value={reference} placeholder="note1, nevent1, or a note link" spellCheck={false}
                onChange={(event) => { setReference(event.target.value); setPreview(null); setEndpoint(null); setAuthorInvoiceError(""); setNoteExpanded(false); }} />
        </label>}
        {loading && <p role="status" className="text-sm text-cyan-100/60">Loading note and author payment details...</p>}
        {preview && <article className="space-y-3" aria-label="Original note">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <UserProfileInline pubkey={preview.event.pubkey} size="md" />
                {preview.active && <span className="text-xs text-cyan-200/60">#{preview.rank} · {preview.rank <= 21 ? "main board" : "waiting room"}</span>}
            </div>
            <div className={`${noteExpanded ? "" : "line-clamp-3"} text-sm leading-relaxed text-cyan-100`}><CompactNoteText text={preview.event.content} /></div>
            <div className="flex flex-wrap gap-x-5 text-xs text-cyan-200/60">
                <button type="button" className="promotion-action focus-pixel min-h-11" aria-expanded={noteExpanded} onClick={() => setNoteExpanded(!noteExpanded)}>{noteExpanded ? "Show less" : "Show full text"}</button>
                <a href={njumpUrl(preview.event.id, "note")} target="_blank" rel="noopener noreferrer" className="promotion-action focus-pixel inline-flex min-h-11 items-center">Open note</a>
                {!initialReference && <button type="button" className="promotion-action focus-pixel min-h-11" disabled={busy} onClick={() => setChangingReference(!changingReference)}>{changingReference ? "Done" : "Change note"}</button>}
            </div>
        </article>}
        <PromotionAmountPicker amount={amount} currentWeight={knownWeight} max={10000000} targets={targets.filter((target) => target.rank === 21)} disabled={busy}
            totalForPromotion={(needed) => totalForPromotion(needed, authorShare)} onChange={setAmount} />
        <div className="flex items-center justify-between gap-3 border-y border-cyan-400/20 py-2 text-sm text-cyan-100/80">
            <div className="flex flex-wrap gap-x-3 gap-y-1">
                <span>Holoboard visibility: <strong>{split.promotion} sats</strong></span>
                <span>Support the author: <strong>{split.author} sats</strong></span>
            </div>
            <button type="button" className={`${actionClass} shrink-0`} disabled={busy} onClick={() => openPanel("allocation")}>Adjust</button>
        </div>
        {split.author > 0 && (authorInvoiceError || (endpoint && invalidTip)) && <div className="space-y-2 border-l-2 border-neon-gold pl-3 text-sm text-neon-gold">
            <p role="alert">{authorInvoiceError ? `Could not prepare author support: ${authorInvoiceError}` : !endpoint?.available ? endpoint?.reason : `The author's wallet accepts ${endpoint.min_sats} to ${endpoint.max_sats} sats. Increase the amount or change the allocation.`}</p>
            <p>Visibility only would allocate {amount} sats to Holoboard visibility and 0 sats to the author{fee > 0 ? `, plus ${fee} sats for appearance` : ""}. Total: {amount+fee} sats. Review the allocation before preparing an invoice.</p>
            <PixelButton size="sm" variant="ghost" disabled={busy} onClick={() => { changeAuthorShare(0); setError(""); }}>Choose visibility only</PixelButton>
        </div>}
        {preview && !preview.active && preview.satsPaid === 0 && <p className="text-xs leading-relaxed text-cyan-100/60">This first promotion sets the campaign's public zap split: {100-authorShare}% Holoboard, {authorShare}% author.</p>}
        {!customized && boost ? <button type="button" className={actionClass} disabled={busy} onClick={() => setCustomized(true)}>Customize &gt;</button> : <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-b border-cyan-400/20 pb-2">
            <button type="button" className={actionClass} disabled={busy || !preview} onClick={() => openPanel("appearance")}>{boost ? "View appearance" : fee > 0 ? `Billboard +${fee} sats` : "Appearance"}</button>
            <button type="button" className={actionClass} disabled={busy} onClick={() => openPanel("allocation")}>{usePublicZap ? "Public author zap" : "Author support"}</button>
            <button type="button" className={actionClass} disabled={busy} onClick={() => openPanel("ranking")}>Target position</button>
            <button type="button" className={actionClass} disabled={busy} onClick={() => openPanel("notifications")}>{notifyEnabled ? "Notifications on" : "Notifications"}</button>
            {boost && <button type="button" className={actionClass} disabled={busy} onClick={() => setCustomized(false)}>&lt; Quick boost</button>}
        </div>}
        {connectionActions}
        {footer(submission)}
    </div>;
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
