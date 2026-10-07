import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { Event } from "nostr-tools/pure";
import { ndk } from "../../lib/ndk";
import { BillboardEditor } from "./BillboardEditor";
import { initialBillboard, validBillboard, type BillboardConfig } from "../../lib/billboard";
import { PixelButton } from "../ui/PixelButton";
import { checkProgress, fetchNotePreview, describeFailure, requestInvoice, type NotePreview } from "../../lib/promote";
import { parseNoteReference, parsePubkey } from "../../lib/nostr";
import { PromotionNotePreview } from "./PromotionNotePreview";
import { HelpContent } from "../Help/HelpContent";
import { ENABLE_NOSTR_CONNECT, ZAP_PRESETS } from "../../config";
import type { RankingTarget } from "../../lib/ranking";
import { PromotionAmountPicker, type AmountSelection } from "./PromotionAmountPicker";
import { PromotionSplit } from "./PromotionSplit";
import { PromotionTabs, type PromotionTab } from "./PromotionTabs";
import { allocatePayment, totalForPromotion, browserSigner, browserWallet, fetchAuthorEndpoint, requestAuthorInvoice, verifyAuthorPayment, type AuthorEndpoint, type AuthorInvoice } from "../../lib/support";
import { ConnectionSettings } from "./ConnectionSettings";
import { useConnections } from "../../hooks/useConnections";
import { hasSavedWalletConnection } from "../../lib/connections";
import { canPayOrCheckInvoice, payInvoiceSafely, type WalletAttempt } from "../../lib/walletPayment";
import { paymentSessionIsPersistent, removePaymentSession } from "../../lib/paymentSession";
import { acknowledgeWalletFailure, getWalletAttempt, getWalletAttemptsSnapshot, subscribeWalletAttempts } from "../../lib/walletAttempts";
import { isMockInvoice, MOCK_INVOICE_MESSAGE } from "../../lib/invoice";

import { PaymentTabs } from "./PaymentTabs";
import { PromotionPayment } from "./PromotionPayment";
import { PromotionPaymentResult } from "./PromotionPaymentResult";
import { UnfinishedPayments } from "./UnfinishedPayments";
import { paymentKey as storageKey, restorePayment, savePayment, unfinishedPayments, updateSavedPayment } from "./paymentRecords";
import { restartBlocked, type PromotionPayment as Payment, type PaymentMethod, type PaymentRecipient } from "./PaymentState";

const FIELD = "focus-pixel w-full border-2 border-cyan-400/40 bg-void px-3 py-2 text-base text-cyan-100";

type Panel = "compose" | "appearance" | "options" | "wallet" | "signer" | "help";

export function DirectPromote({ initialReference = "", currentWeight, rankingTargets, onPaid, onClose, initialSection, footerHost, navigationHost, onPresentationChange }: {
    initialReference?: string; currentWeight?: number; rankingTargets: RankingTarget[]; onPaid?: () => void;
    onClose: () => void; initialSection?: string; footerHost: HTMLDivElement | null; navigationHost: HTMLDivElement | null;
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
    const recovered = useRef(restorePayment(initialReference));
    const [savedPayment, setPayment] = useState<Payment | null>(() => recovered.current?.editing ? null : recovered.current);
    const attempts = useSyncExternalStore(subscribeWalletAttempts, getWalletAttemptsSnapshot);
    const payment = useMemo(() => savedPayment ? {
        ...savedPayment,
        boardAttempt: attempts.get(savedPayment.board.paymentHash) ?? getWalletAttempt(savedPayment.board.paymentHash, savedPayment.boardAttempt),
        authorAttempt: savedPayment.author ? attempts.get(savedPayment.author.payment_hash) ?? getWalletAttempt(savedPayment.author.payment_hash, savedPayment.authorAttempt) : undefined,
    } : null, [savedPayment, attempts]);
    const [reference, setReference] = useState(() => recovered.current?.note ?? initialReference);
    const latestReference = useRef(reference);
    const [loadVersion, setLoadVersion] = useState(0);
    const [, setRecordsVersion] = useState(0);
    const preferredWallet = hasSavedWalletConnection;
    const [walletFirst, setWalletFirst] = useState(preferredWallet);
    const [method, setMethod] = useState<PaymentMethod>(() => preferredWallet() ? "wallet" : "invoice");
    const [recipient, setRecipient] = useState<PaymentRecipient>(() => recovered.current?.author && (recovered.current.promotionPaid || isMockInvoice(recovered.current.board.invoice)) ? "author" : "board");
    const [restartConfirm, setRestartConfirm] = useState(false);
    const restartedDraft = useRef<Payment | null>(null);
    const [amount, setAmount] = useState<number>(recovered.current?.draft?.amount ?? (recovered.current ? (recovered.current.board.promotionSats ?? recovered.current.board.amountSats - (recovered.current.board.billboardFeeSats ?? 0)) + (recovered.current.author?.amount_sats ?? 0) : ZAP_PRESETS[1]));
    const [amountSelection, setAmountSelection] = useState<AmountSelection>(recovered.current?.draft?.amountSelection ?? { mode: "amount", rank: null, custom: false });
    const [authorShare, setAuthorShare] = useState(recovered.current?.draft?.authorShare ?? recovered.current?.authorShare ?? 20);
    const [preview, setPreview] = useState<NotePreview | null>(null);
    const [endpoint, setEndpoint] = useState<AuthorEndpoint | null>(null);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [walletPart, setWalletPart] = useState<PaymentRecipient | null>(null);
    const [error, setError] = useState("");
    const [authorInvoiceError, setAuthorInvoiceError] = useState("");
    const [billboardEnabled, setBillboardEnabled] = useState(recovered.current?.draft?.billboardEnabled ?? false);
    const [config, setConfig] = useState<BillboardConfig>(() => recovered.current?.draft?.config ?? initialBillboard(""));
    const [notifyEnabled, setNotifyEnabled] = useState(recovered.current?.draft?.notifyEnabled ?? false);
    const [notifyPubkey, setNotifyPubkey] = useState(recovered.current?.draft?.notifyPubkey ?? "");
    const [publicZapSigner, setPublicZapSigner] = useState<ReturnType<typeof browserSigner>>();
    const [actualRank, setActualRank] = useState<number | null>(null);
    const [now, setNow] = useState(Date.now);
    const [canResume, setCanResume] = useState(paymentSessionIsPersistent);
    const pendingSessions = unfinishedPayments(parseNoteReference(reference)?.id);
    const abort = useRef<AbortController | null>(null);
    const latestPayment = useRef(payment);
    useEffect(() => { latestPayment.current = payment; }, [payment]);
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
    const boost = preview?.active ?? (!!initialReference && parseNoteReference(reference)?.id === parseNoteReference(initialReference)?.id && (currentWeight ?? 0) > 0);
    const knownWeight = preview?.weight ?? currentWeight ?? 0;
    const invalidTip = split.author > 0 && (!endpoint?.available || split.author < endpoint.min_sats || split.author > endpoint.max_sats);
    // Consent belongs to the selected connection in this form and is never
    // restored from a saved invoice's publicZap flag after a refresh.
    const hasPublicZapConsent = () => ENABLE_NOSTR_CONNECT && !!publicZapSigner && publicZapSigner === browserSigner();
    const usePublicZap = hasPublicZapConsent() && !!endpoint?.allows_nostr;
    const compact = boost && panel === "compose" && !payment;
    const finished = !!payment?.promotionPaid && (!payment.author || payment.tipStatus !== "pending");
    const hasTabs = !boost && !payment && (panel === "compose" || panel === "appearance" || panel === "options");
    const tabPanelProps = hasTabs ? { role: "tabpanel", id: `${navigationId}-panel`, "aria-labelledby": `${navigationId}-${panel}`, tabIndex: 0 } : {};
    const editorNavigation = hasTabs && navigationHost ? createPortal(<PromotionTabs id={navigationId} active={panel as PromotionTab}
        onChange={selectTab} disabled={busy} billboardEnabled={billboardEnabled} notificationsEnabled={notifyEnabled} />, navigationHost) : null;
    const navigation = payment && !finished && panel === "compose" && navigationHost ? createPortal(
        <PaymentTabs id={navigationId} active={method} walletFirst={walletFirst} onChange={setMethod} />, navigationHost) : editorNavigation;
    const restoreDraft = (saved: Payment, loaded: NotePreview) => {
        const draft = saved.draft;
        setAmount(draft?.amount ?? (saved.board.promotionSats ?? saved.board.amountSats - (saved.board.billboardFeeSats ?? 0)) + (saved.author?.amount_sats ?? 0));
        setAmountSelection(draft?.amountSelection ?? { mode: "amount", rank: null, custom: false });
        setAuthorShare(draft?.authorShare ?? saved.authorShare ?? loaded.authorShare);
        setConfig(draft?.config ?? loaded.billboard ?? initialBillboard(loaded.event.content));
        setBillboardEnabled(saved.promotionPaid && loaded.active ? false : draft?.billboardEnabled ?? false);
        setNotifyEnabled(draft?.notifyEnabled ?? saved.notificationRequested ?? false);
        setNotifyPubkey(draft?.notifyPubkey ?? "");
    };
    useEffect(() => {
        const body = footerHost?.closest('[role="dialog"]')?.querySelector<HTMLElement>("[data-modal-body]");
        if (!body || (panel === "help" && helpSection)) return;
        body.scrollTop = 0;
        if (body.closest('[role="dialog"]')?.querySelector('[role="tablist"]')?.contains(document.activeElement)) return;
        if (panel !== "compose" || finished) body.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
        else body.querySelector<HTMLElement>('input:not([disabled]), button:not([disabled]), a[href]')?.focus({ preventScroll: true });
    }, [panel, method, finished, footerHost, helpSection]);
    useEffect(() => {
        onPresentationChange({ compact, boost, payment: payment !== null });
    }, [compact, boost, payment, onPresentationChange]);
    const openHelp = (section = "") => { setHelpSection(section); openPanel("help"); };
    const targets = rankingTargets.filter((target) => !boost || target.rank < (preview?.rank ?? 1000000));
    const actionClass = "promotion-action focus-pixel inline-flex min-h-11 items-center gap-2 text-cyan-200/75 hover:text-neon-cyan disabled:opacity-40";
    const signerAction = ENABLE_NOSTR_CONNECT && <button type="button" className={actionClass} disabled={busy} onClick={() => openPanel("signer")}>
        {browserSigner() ? "Nostr signer settings" : "Connect Nostr for a public zap"} &gt;
    </button>;
    const paymentOptions = <button type="button" className={actionClass} disabled={busy} onClick={() => openPanel("options")}>Payment options &gt;</button>;
    const footer = (content: ReactNode) => footerHost ? createPortal(content, footerHost) : null;
    const changeReference = (next: string) => {
        latestReference.current = next;
        if (parseNoteReference(next)?.id !== parseNoteReference(reference)?.id) {
            abort.current?.abort();
            if (payment) savePayment({ ...payment, editing: true });
            setPayment(null); recovered.current = null; restartedDraft.current = null;
            setAmount(ZAP_PRESETS[1]); setAmountSelection({ mode: "amount", rank: null, custom: false });
            setAuthorShare(20); setBillboardEnabled(false); setConfig(initialBillboard(""));
            setNotifyEnabled(false); setNotifyPubkey(""); setPublicZapSigner(undefined);
            setActualRank(null); setRestartConfirm(false); setRecipient("board");
            setError(""); notified.current = false;
        }
        setReference(next); setPreview(null); setEndpoint(null); setAuthorInvoiceError(""); setNoteExpanded(false);
        setLoading(!!parseNoteReference(next));
    };
    const resumePayment = (saved: Payment) => {
        if (busy) return;
        if (payment) savePayment({ ...payment, editing: true });
        changeReference(saved.note);
        const resumed = { ...saved, editing: false };
        savePayment(resumed); setPayment(resumed); setRecordsVersion((version) => version + 1);
        setLoadVersion((version) => version + 1); selectTab("compose"); setChangingReference(false);
        const first = preferredWallet(); setWalletFirst(first); setMethod(first ? "wallet" : "invoice");
        setRecipient(saved.promotionPaid && saved.author ? "author" : "board");
    };

    useEffect(() => {
        if (!parseNoteReference(reference)) { setPreview(null); setEndpoint(null); setLoading(false); return; }
        const controller = new AbortController();
        const timer = window.setTimeout(() => {
            setLoading(true); setError(""); setEndpoint(null);
            void fetchNotePreview(reference, controller.signal).then(async (loaded) => {
                if (controller.signal.aborted || loaded.event.id !== parseNoteReference(latestReference.current)?.id) return;
                setPreview(loaded); setConfig(loaded.billboard ?? initialBillboard(loaded.event.content));
                setBillboardEnabled(false); setAuthorShare(loaded.authorShare);
                const saved = restorePayment(loaded.event.id);
                if (saved) {
                    if (!saved.editing) setPayment(saved);
                    restoreDraft(saved, loaded);
                }
                const restarted = restartedDraft.current;
                if (!saved && restarted) { restoreDraft(restarted, loaded); restartedDraft.current = null; }
                try {
                    const author = await fetchAuthorEndpoint(reference, controller.signal);
                    if (!controller.signal.aborted) {
                        setEndpoint(author);
                        if (!saved && !restarted && author.reason_code === "no_address" && !loaded.active && loaded.satsPaid === 0) setAuthorShare(0);
                    }
                }
                catch { if (!controller.signal.aborted) setEndpoint({ available: false, author: loaded.event.pubkey, reason: "Could not reach the author's wallet. Choose visibility only or try again later.", min_sats: 1, max_sats: 0, allows_nostr: false }); }
            }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(describeFailure(failure)); })
                .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        }, initialReference ? 0 : 350);
        return () => { controller.abort(); window.clearTimeout(timer); };
    }, [reference, initialReference, loadVersion]);
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
                    setPayment((current) => current?.board.paymentHash === invoice.paymentHash ? { ...current, promotionPaid: true, added: progress.satsPaid, billboardApplied: progress.billboardApplied, feeConverted: progress.feeConverted } : current);
                    return;
                }
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
            if (!controller.signal.aborted && boardInvoice.noteId === parseNoteReference(latestReference.current)?.id) {
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

    const start = async () => {
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
                notified.current = false; setActualRank(null);
                const prepared: Payment = { note: reference, noteSummary: preview.event.content.replace(/\s+/g, " ").trim().slice(0, 160), board, author, tipStatus: "pending", promotionPaid: false, added: 0, authorShare, publicZap: usePublicZap, notificationRequested: contact !== null,
                    draft: { amount, amountSelection, authorShare, billboardEnabled, config, notifyEnabled, notifyPubkey } };
                savePayment(prepared); setPayment(prepared); selectTab("compose");
                const first = preferredWallet(); setWalletFirst(first); setMethod(first ? "wallet" : "invoice");
                setRecipient("board"); setRestartConfirm(false);
            }
        } catch (failure) { if (!controller.signal.aborted) setError(describeFailure(failure)); }
        finally { if (!controller.signal.aborted) setBusy(false); }
    };
    const payWithWallet = async () => {
        const pending = payment;
        const wallet = browserWallet(); if (!wallet || !pending || busy) return;
        if (isMockInvoice(pending.board.invoice)) { setError(MOCK_INVOICE_MESSAGE); return; }
        setBusy(true); setError("");
        const controller = new AbortController(); abort.current = controller;
        const saveAttempt = (part: "boardAttempt" | "authorAttempt", attempt: WalletAttempt) => {
            updateSavedPayment(pending.note, pending.board.paymentHash, { [part]: attempt });
            setPayment((latest) => latest?.board.paymentHash === pending.board.paymentHash ? { ...latest, [part]: attempt } : latest);
        };
        const failures: string[] = [];
        try {
            await wallet.enable();
            if (controller.signal.aborted) return;
            if (!pending.promotionPaid) {
                try {
                    const progress = await checkProgress(pending.board.paymentHash, pending.board.noteId, controller.signal);
                    if (controller.signal.aborted) return;
                    if (progress.settled) {
                        updateSavedPayment(pending.note, pending.board.paymentHash, { promotionPaid: true, added: progress.satsPaid, billboardApplied: progress.billboardApplied, feeConverted: progress.feeConverted });
                        setPayment((latest) => latest?.board.paymentHash === pending.board.paymentHash ? { ...latest, promotionPaid: true, added: progress.satsPaid, billboardApplied: progress.billboardApplied, feeConverted: progress.feeConverted } : latest);
                    } else if (canPayOrCheckInvoice(wallet, pending.board.expiresAt, pending.boardAttempt)) {
                        setWalletPart("board");
                        await payInvoiceSafely(wallet, pending.board.invoice, pending.board.paymentHash, pending.boardAttempt, (attempt) => saveAttempt("boardAttempt", attempt), pending.board.expiresAt);
                    }
                } catch (failure) { failures.push(`Visibility: ${describeFailure(failure)}`); }
                finally { if (!controller.signal.aborted) setWalletPart(null); }
            }
            if (controller.signal.aborted) return;
            const latest = latestPayment.current;
            if (pending.author && pending.tipStatus === "pending" && latest?.author?.payment_hash === pending.author.payment_hash && latest.tipStatus === "pending") {
                try {
                    if (canPayOrCheckInvoice(wallet, pending.author.expires_at, pending.authorAttempt)) {
                        setWalletPart("author");
                        const proof = await payInvoiceSafely(wallet, pending.author.invoice, pending.author.payment_hash, pending.authorAttempt, (attempt) => saveAttempt("authorAttempt", attempt), pending.author.expires_at);
                        if (proof.preimage && await verifyAuthorPayment(pending.note, pending.author, { preimage: proof.preimage })) setPayment((current) => current?.author?.payment_hash === pending.author?.payment_hash ? { ...current!, tipStatus: "confirmed" } : current);
                        else failures.push("The wallet returned no verified payment proof. Check your wallet before retrying author support.");
                    }
                } catch (failure) { failures.push(`Author support: ${describeFailure(failure)}`); }
                finally { if (!controller.signal.aborted) setWalletPart(null); }
            }
            if (!controller.signal.aborted && failures.length) setError(`${failures.join(" ")} Any confirmed part is kept.`);
        } catch (failure) { if (!controller.signal.aborted) setError(`${describeFailure(failure)} Any confirmed part is kept. Check your wallet before retrying.`); }
        finally { if (!controller.signal.aborted) { setWalletPart(null); setBusy(false); } }
    };
    const replaceAuthorInvoice = async () => {
        if (!payment?.author || !endpoint?.available || busy || (payment.authorAttempt && payment.authorAttempt.state !== "unpaid")) return;
        setBusy(true); setError("");
        const controller = new AbortController(); abort.current = controller;
        try {
            const publicZap = !!payment.publicZap && hasPublicZapConsent() && endpoint.allows_nostr;
            const author = await requestAuthorInvoice(payment.note, payment.author.amount_sats, endpoint, publicZap, payment.board.noteId, controller.signal);
            if (!controller.signal.aborted) setPayment((current) => current?.author?.payment_hash === payment.author?.payment_hash ? { ...current!, author, authorAttempt: undefined, publicZap } : current);
        } catch (failure) { if (!controller.signal.aborted) setError(describeFailure(failure)); }
        finally { if (!controller.signal.aborted) setBusy(false); }
    };
    const replaceBoardInvoice = async () => {
        if (!payment || payment.promotionPaid || busy || Date.now() < payment.board.expiresAt*1000 || (payment.boardAttempt && payment.boardAttempt.state !== "unpaid")) return;
        setBusy(true); setError("");
        const controller = new AbortController(); abort.current = controller;
        try {
            const progress = await checkProgress(payment.board.paymentHash, payment.board.noteId, controller.signal);
            if (controller.signal.aborted) return;
            if (progress.settled) {
                setPayment((current) => current?.board.paymentHash === payment.board.paymentHash ? { ...current, promotionPaid: true, added: progress.satsPaid, billboardApplied: progress.billboardApplied, feeConverted: progress.feeConverted } : current);
                return;
            }
            const attempt = getWalletAttempt(payment.board.paymentHash, payment.boardAttempt);
            if (attempt && attempt.state !== "unpaid") return;
            const draft = payment.draft;
            const appearance = payment.board.billboardFeeSats > 0 ? { billboard: draft?.config ?? config } : undefined;
            const contact = draft?.notifyEnabled ? parsePubkey(draft.notifyPubkey) ?? undefined : undefined;
            const visibility = payment.board.promotionSats ?? payment.board.amountSats - (payment.board.billboardFeeSats ?? 0);
            const board = await requestInvoice(payment.note, visibility, controller.signal, appearance, contact, payment.authorShare);
            if (!controller.signal.aborted) setPayment((current) => current?.board.paymentHash === payment.board.paymentHash ? { ...current, board, boardAttempt: undefined, notificationRequested: !!contact } : current);
        } catch (failure) { if (!controller.signal.aborted) setError(describeFailure(failure)); }
        finally { if (!controller.signal.aborted) setBusy(false); }
    };
    const startAnother = () => {
        if (!payment) return;
        removePaymentSession(storageKey(payment.note));
        setPayment(null); setError(""); setActualRank(null); notified.current = false; setRestartConfirm(false); selectTab("compose");
        setRecordsVersion((version) => version + 1);
    };
    const backToPromotion = (saved = latestPayment.current) => {
        if (!saved) return;
        abort.current?.abort();
        savePayment({ ...saved, editing: true });
        if (preview) restoreDraft(saved, preview);
        setPayment(null); setBusy(false); setWalletPart(null); setError(""); setRestartConfirm(false);
        setActualRank(null); notified.current = false; selectTab("compose");
        setRecordsVersion((version) => version + 1); setLoadVersion((version) => version + 1);
    };
    const restartPayment = async () => {
        if (!payment || busy || restartBlocked(payment)) return;
        setBusy(true); setError("");
        const controller = new AbortController(); abort.current = controller;
        try {
            if (!isMockInvoice(payment.board.invoice)) {
                try {
                    const progress = await checkProgress(payment.board.paymentHash, payment.board.noteId, controller.signal);
                    if (controller.signal.aborted) return;
                    if (progress.settled) {
                        backToPromotion({ ...payment, promotionPaid: true, added: progress.satsPaid, billboardApplied: progress.billboardApplied, feeConverted: progress.feeConverted });
                        return;
                    }
                } catch { /* Explicit no-payment confirmation allows abandoning an unattempted session offline. */ }
            }
            if (controller.signal.aborted) return;
            const current = latestPayment.current;
            if (!current || current.board.paymentHash !== payment.board.paymentHash) return;
            const latest = { ...current, boardAttempt: getWalletAttempt(current.board.paymentHash, current.boardAttempt),
                authorAttempt: current.author ? getWalletAttempt(current.author.payment_hash, current.authorAttempt) : undefined };
            if (restartBlocked(latest)) { backToPromotion(latest); return; }
            if (preview) restoreDraft(payment, preview);
            restartedDraft.current = payment;
            abort.current?.abort();
            setBusy(false);
            startAnother();
            setLoadVersion((version) => version + 1);
        } finally { if (!controller.signal.aborted) setBusy(false); }
    };
    const cannotPrepare = busy || loading || !preview || invalidTip || (billboardEnabled && !validBillboard(config, preview.event.content, preview.images));
    const submission = <div className="space-y-2">
        {error && <p role="alert" className="text-sm text-neon-pink">{error}</p>}
        <PixelButton className="w-full min-h-11" variant="accent" disabled={cannotPrepare} onClick={() => void start()}>
            {busy ? "Preparing payments" : `${boost ? "Boost" : "Promote"} ${amount+fee} sats`}
        </PixelButton>
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
            {preview ? <BillboardEditor key={preview.event.id} preview={preview} config={config} onChange={setConfig} enabled={billboardEnabled} onEnabledChange={setBillboardEnabled} amount={split.promotion} /> : <div className="space-y-3 text-sm text-cyan-100/75">
                <p>Billboard is a paid appearance for an existing note. Load a note to preview its text, available images and price.</p>
                <label className="block space-y-2"><span className="promotion-label">Note link</span>
                    <input aria-label="Note link" className={FIELD} value={reference} disabled={busy} placeholder="note1, nevent1, or a note link" spellCheck={false} onChange={(event) => changeReference(event.target.value)} />
                </label>
                {loading && <p role="status" className="text-xs">Loading note for Billboard...</p>}
                <p className="text-xs">Billboard can be chosen when starting a promotion period. Active notes keep their current appearance.</p>
            </div>}
        </div>
        <div hidden={panel !== "options"} className="space-y-4 text-sm text-cyan-100/80">
            <section aria-label="How to pay" className="space-y-3">
                <h4 className="promotion-label text-neon-cyan">Wallet</h4>
                <p>Open, copy or scan invoices with any Lightning wallet. No connection is required.</p>
                <button type="button" className={actionClass} disabled={busy} onClick={() => openPanel("wallet")}>{browserWallet() ? "Payment wallet settings" : "Connect wallet to pay here"} &gt;</button>
            </section>
            {payment?.publicZap && signerAction}
            {!payment && <section aria-label="Notifications" className="space-y-3 border-t border-cyan-400/20 pt-3">
                <h4 className="promotion-label text-neon-cyan">Notifications <span className="text-cyan-100/50">/ optional</span></h4>
                <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={notifyEnabled} disabled={busy} onChange={(event) => { setNotifyEnabled(event.target.checked); setError(""); }} />Send me a confirmation DM</label>
                {notifyEnabled && <><input aria-label="Npub for confirmation" className={FIELD} value={notifyPubkey} onChange={(event) => { setNotifyPubkey(event.target.value); setError(""); }} placeholder="npub1..." /><p>Reply YES to the confirmation DM to receive one expiry notification.</p></>}
                {ENABLE_NOSTR_CONNECT && notifyEnabled && (browserSigner() ? <button type="button" className={actionClass} disabled={busy} onClick={() => setNotifyPubkey(connections.signerPubkey)}>Use connected Nostr identity</button> :
                    <button type="button" className={actionClass} disabled={busy} onClick={() => openPanel("signer")}>Connect Nostr to use your npub &gt;</button>)}
            </section>}
        </div>
        {(panel === "wallet" || ENABLE_NOSTR_CONNECT && panel === "signer") && <ConnectionSettings section={panel} embedded disabled={busy} />}
        {panel === "help" && <HelpContent section={helpSection} />}
    </div>;
    if (panel !== "compose") return <>
        {navigation}
        {panelBody}
        {footer(hasTabs ? submission : <button type="button" className={`${actionClass} w-full justify-center`} onClick={closePanel}> &lt; Back to {panelHistory[panelHistory.length - 2] !== "compose" ? "settings" : payment ? "payment" : boost ? "boost" : "promotion"}</button>)}
    </>;

    if (payment && finished) return <PromotionPaymentResult payment={payment} actualRank={actualRank} busy={busy}
        onDone={onClose} onAnother={startAnother} onHelp={() => openHelp("payments")} footer={footer} />;
    if (payment) return <>{navigation}<PromotionPayment id={navigationId} payment={payment} method={method} recipient={recipient}
        onRecipient={setRecipient} wallet={browserWallet()} walletName={connections.walletName} connecting={connections.walletStatus === "connecting"}
        busy={busy} walletPart={walletPart} now={now} canResume={canResume} error={error} actualRank={actualRank}
        onPay={() => void payWithWallet()} onReplaceAuthor={() => void replaceAuthorInvoice()}
        onReplaceBoard={() => void replaceBoardInvoice()}
        onReportAuthor={() => setPayment({ ...payment, tipStatus: "reported" })}
        onAcknowledge={(part) => {
            const attempt = part === "board" ? payment.boardAttempt : payment.authorAttempt;
            if (!attempt) return;
            const hash = part === "board" ? payment.board.paymentHash : payment.author!.payment_hash;
            const next = { ...payment, [part === "board" ? "boardAttempt" : "authorAttempt"]: acknowledgeWalletFailure(hash, attempt) };
            savePayment(next); setPayment(next); setError("");
        }}
        onHelp={() => openHelp("payments")} onSigner={() => openPanel("signer")} onRestart={() => void restartPayment()}
        onBack={() => backToPromotion()}
        restartConfirm={restartConfirm} onRestartConfirm={setRestartConfirm} hasPublicZapConsent={hasPublicZapConsent()} authorCanReplace={!!endpoint?.available} footer={footer} /></>;
    return <>{navigation}<div className={boost ? "space-y-2" : "space-y-4"} aria-busy={loading || busy} {...tabPanelProps}>
        <UnfinishedPayments payments={pendingSessions} forNote={!!parseNoteReference(reference)} disabled={busy} persistent={paymentSessionIsPersistent()} onResume={resumePayment} />
        {(!preview && !initialReference || changingReference) && <label className="block space-y-2">
            <span className="promotion-label text-cyan-200/70">Note link</span>
            <input className={`${FIELD} min-h-11 text-base`} value={reference} placeholder="note1, nevent1, or a note link" spellCheck={false} disabled={busy}
                onChange={(event) => changeReference(event.target.value)} />
        </label>}
        {loading && <p role="status" className="text-sm text-cyan-100/60">Loading note and author payment details...</p>}
        {preview && <PromotionNotePreview preview={preview} compact={boost} expanded={noteExpanded} onToggle={() => setNoteExpanded(!noteExpanded)}>
            {(!initialReference || !boost || pendingSessions.length > 0) && <button type="button" className="promotion-action focus-pixel min-h-11" disabled={busy} onClick={() => setChangingReference(!changingReference)}>{changingReference ? "Done" : "Change note"}</button>}
        </PromotionNotePreview>}
        {!boost && billboardEnabled && <p className="text-xs text-neon-gold">Billboard +{fee} sats, included in the total.</p>}
        <PromotionAmountPicker amount={amount} currentWeight={knownWeight} max={10000000} appearanceFee={fee} targets={targets} disabled={busy}
            selection={amountSelection} onSelectionChange={setAmountSelection}
            totalForPromotion={(needed) => totalForPromotion(needed, authorShare)} onChange={setAmount} />
        <PromotionSplit author={preview?.event.pubkey} authorShare={authorShare} promotionSats={split.promotion} authorSats={split.author} disabled={busy} onChange={changeAuthorShare}>
            <div className="flex flex-wrap items-center justify-between gap-x-3 text-cyan-100/75">
                {authorShare !== campaignShare && <button type="button" className={actionClass} disabled={busy} onClick={() => changeAuthorShare(campaignShare)} aria-label={existingCampaign ? "Use campaign split" : "Use default split"}>
                    <span className="sm:hidden">Reset</span><span className="hidden sm:inline">{existingCampaign ? "Use campaign split" : "Use default split"}</span>
                </button>}
                {ENABLE_NOSTR_CONNECT && endpoint?.allows_nostr && authorShare > 0 && <details className="disclosure">
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
