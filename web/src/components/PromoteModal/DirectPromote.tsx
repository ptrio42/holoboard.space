import { useCallback, useEffect, useRef, useState } from "react";
import { BillboardEditor } from "./BillboardEditor";
import { initialBillboard, validBillboard, type BillboardConfig } from "../../lib/billboard";
import { PixelButton } from "../ui/PixelButton";
import { CopyButton } from "../ui/CopyButton";
import { QrCode } from "../ui/QrCode";
import { Spinner } from "../ui/Spinner";
import {
    checkProgress,
    fetchNotePreview,
    type NotePreview,
    describeFailure,
    requestInvoice,
    type PromoteInvoice,
} from "../../lib/promote";
import { formatSats } from "../../lib/nostr";
import { ZAP_PRESETS } from "../../config";
import type { RankingTarget } from "../../lib/ranking";
import { PromotionAmountPicker } from "./PromotionAmountPicker";

/**
 * Promoting with nothing but a note and a payment.
 *
 * The other route in this dialog signs and publishes a mention as you, which is
 * why it needs an extension. Nothing about the board requires that: the relay
 * never checks who asked. This is the version for a phone, or for anybody who
 * would rather not connect a key to a website.
 */

/** How often to ask whether the invoice has been paid. */
const POLL_MS = 3_000;

/** Matches the bounds the relay enforces, so a refusal never comes as a surprise. */
const MAX_SATS = 10_000_000;

type Phase =
    | { kind: "idle" }
    | { kind: "requesting" }
    | { kind: "waiting"; invoice: PromoteInvoice }
    | { kind: "paid"; sats: number; billboardApplied: boolean; feeConverted: boolean }
    | { kind: "failed"; message: string };

export function DirectPromote({ initialReference = "", currentWeight, rankingTargets, onPaid }: {
    initialReference?: string;
    currentWeight?: number;
    rankingTargets: RankingTarget[];
    onPaid?: () => void;
}) {
    const [reference, setReference] = useState(initialReference);
    const [amount, setAmount] = useState<number>(ZAP_PRESETS[1]);
    const [phase, setPhase] = useState<Phase>({ kind: "idle" });
    const abort = useRef<AbortController | null>(null);
    const previewAbort = useRef<AbortController | null>(null);
    const [preview, setPreview] = useState<NotePreview | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [billboardEnabled, setBillboardEnabled] = useState(false);
    const [config, setConfig] = useState<BillboardConfig>(() => initialBillboard(""));
    const promotionAmount = amount;
    const fee = billboardEnabled && !preview?.billboard ? preview?.billboardFeeSats ?? 0 : 0;
    const invalidBillboard = billboardEnabled && (!preview || preview.active || !validBillboard(config, preview.event.content, preview.images));
    const knownWeight = preview?.weight ?? (reference.trim() === initialReference ? currentWeight : 0) ?? 0;

    const loadPreview = async () => {
        previewAbort.current?.abort();
        const controller = new AbortController();
        previewAbort.current = controller;
        setPreviewLoading(true);
        setPhase({ kind: "idle" });
        try {
            const loaded = await fetchNotePreview(reference.trim(), controller.signal);
            if (controller.signal.aborted) return;
            setPreview(loaded);
            setConfig(loaded.billboard ?? initialBillboard(loaded.event.content));
            setBillboardEnabled(false);
        } catch (error) {
            if (!controller.signal.aborted) setPhase({ kind: "failed", message: describeFailure(error) });
        } finally {
            if (!controller.signal.aborted) setPreviewLoading(false);
        }
    };

    useEffect(() => () => { abort.current?.abort(); previewAbort.current?.abort(); }, []);
    const paidCallback = useRef(onPaid);
    useEffect(() => { paidCallback.current = onPaid; }, [onPaid]);
    const notified = useRef(false);
    useEffect(() => {
        if (phase.kind === "paid" && !notified.current) {
            notified.current = true;
            paidCallback.current?.();
        }
        if (phase.kind !== "paid") notified.current = false;
    }, [phase.kind]);

    const start = useCallback(async () => {
        const note = reference.trim();
        if (!note) {
            setPhase({ kind: "failed", message: "Paste a note reference first." });
            return;
        }

        abort.current?.abort();
        abort.current = new AbortController();
        setPhase({ kind: "requesting" });

        try {
            const controller = abort.current;
            const invoice = await requestInvoice(note, promotionAmount, controller.signal,
                billboardEnabled ? { billboard: config } : undefined);
            if (!controller.signal.aborted) setPhase({ kind: "waiting", invoice });
        } catch (error) {
            if (!abort.current?.signal.aborted) setPhase({ kind: "failed", message: describeFailure(error) });
        }
    }, [reference, promotionAmount, billboardEnabled, config]);

    // Watch for the payment while a QR code is on screen.
    useEffect(() => {
        if (phase.kind !== "waiting") return;

        const { invoice } = phase;
        const controller = new AbortController();
        let timer: number | undefined;
        const tick = async () => {
            try {
                const progress = await checkProgress(invoice.paymentHash, invoice.noteId, controller.signal);
                if (controller.signal.aborted) return;
                if (progress.settled) {
                    setPhase({ kind: "paid", sats: progress.satsPaid, billboardApplied: progress.billboardApplied, feeConverted: progress.feeConverted });
                    return;
                }
                if (!progress.pending || Date.now() >= invoice.expiresAt * 1000) {
                    setPhase({ kind: "failed", message: "This invoice expired without a confirmed payment. Check your wallet before requesting another." });
                    return;
                }
            } catch {
                // A failed poll does not prove that a payment failed.
            }
            if (!controller.signal.aborted) timer = window.setTimeout(() => void tick(), POLL_MS);
        };
        void tick();
        return () => { controller.abort(); window.clearTimeout(timer); };
    }, [phase]);

    if (phase.kind === "paid") {
        return (
            <div className="space-y-3">
                <p className="font-pixel text-[11px] tracking-widest text-neon-gold">Paid.</p>
                <p className="text-xs leading-relaxed text-cyan-100/70">
                    The note is on the board with {formatSats(phase.sats)} sats against it. Pay
                    again any time to move it further up.
                </p>
                {phase.billboardApplied && <p className="text-xs text-neon-cyan">Your billboard appearance is now active.</p>}
                {phase.feeConverted && <p className="text-xs text-neon-gold">Appearance was no longer available. Its fee was credited to ranking promotion instead.</p>}
                <PixelButton onClick={() => { setPhase({ kind: "idle" }); setPreview(null); setBillboardEnabled(false); }}>
                    Promote another
                </PixelButton>
            </div>
        );
    }

    if (phase.kind === "waiting") {
        const { invoice } = phase;
        return (
            <div className="space-y-4">
                <p className="text-xs leading-relaxed text-cyan-100/70">
                    Pay {invoice.amountSats} sats with any Lightning wallet. This page notices on
                    its own; you do not have to come back and tell it.
                </p>

                <p className="text-xs text-cyan-100/70">Ranking promotion: {invoice.promotionSats} sats. Billboard appearance: {invoice.billboardFeeSats} sats.</p>
                <div className="flex justify-center">
                    <QrCode value={invoice.invoice} label="Lightning invoice QR code" />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <code className="min-w-0 flex-1 border-2 border-cyan-400/30 bg-void p-2
                        text-[10px] break-all text-cyan-200/80 select-all">
                        {invoice.invoice}
                    </code>
                    <CopyButton value={invoice.invoice} label="Copy invoice" />
                </div>

                <div className="flex items-center gap-2 text-[11px] text-cyan-300/50">
                    <Spinner />
                    <span>Waiting for the payment</span>
                </div>

                <a
                    href={`lightning:${invoice.invoice}`}
                    className="focus-pixel inline-block font-pixel text-[9px] tracking-widest
                        text-cyan-300/50 hover:text-neon-cyan"
                >
                    Open in a wallet
                </a>
            </div>
        );
    }

    return (
        // Native fieldset layout collapses the preview's size-query container in Chrome.
        // Inert keeps every control frozen while the invoice is being created.
        <div inert={phase.kind === "requesting"} aria-busy={phase.kind === "requesting"} className="min-w-0 space-y-4">
            <p className="text-xs leading-relaxed text-cyan-100/70">
                Paste the note you want promoted and pay the invoice. A link from njump or any
                other client is fine. No extension, no signing in, and it works for anyone's note
                rather than only your own.
            </p>

            <label className="block space-y-1">
                <span className="font-pixel text-[9px] tracking-widest text-cyan-300/50">
                    Note reference
                </span>
                <input
                    value={reference}
                    onChange={(event) => {
                        previewAbort.current?.abort();
                        setReference(event.target.value); setPreview(null); setPreviewLoading(false);
                        setBillboardEnabled(false); setPhase({ kind: "idle" });
                    }}
                    placeholder="note1..., nevent1..., or a link to the note"
                    spellCheck={false}
                    className="focus-pixel w-full border-2 border-cyan-400/30 bg-void p-2 text-xs
                        text-cyan-100 placeholder:text-cyan-300/25"
                />
            </label>

            <PixelButton size="sm" onClick={() => void loadPreview()} disabled={!reference.trim() || previewLoading || phase.kind === "requesting"}>
                {previewLoading ? "Loading preview" : "Load note & preview"}
            </PixelButton>
            {preview && <BillboardEditor preview={preview} config={config} onChange={setConfig}
                enabled={billboardEnabled} onEnabledChange={setBillboardEnabled} amount={promotionAmount} />}
            <PromotionAmountPicker amount={amount} currentWeight={knownWeight} max={MAX_SATS}
                targets={rankingTargets} onChange={setAmount} />
            <div className="space-y-1 border-t-2 border-cyan-400/20 pt-3 text-xs text-cyan-100/70">
                <p>Ranking promotion: {formatSats(promotionAmount)} sats</p>
                <p>Billboard appearance: {formatSats(fee)} sats</p>
                <p className="text-neon-gold">Total: {formatSats(promotionAmount + fee)} sats</p>
                {billboardEnabled && <p className="pt-2 leading-relaxed">If appearance becomes unavailable before settlement,
                    its fee goes toward ranking promotion instead. After the note expires, a new billboard purchase is required.</p>}
            </div>

            {phase.kind === "failed" && (
                <p className="border-2 border-neon-pink/40 bg-neon-pink/5 p-2 text-xs text-neon-pink">
                    {phase.message}
                </p>
            )}

            <PixelButton
                variant="accent"
                onClick={() => void start()}
                disabled={phase.kind === "requesting" || previewLoading || invalidBillboard}
            >
                {phase.kind === "requesting"
                    ? "Asking the relay"
                    : `Get invoice, ${formatSats(promotionAmount + fee)} sats`}
            </PixelButton>
        </div>
    );
}
