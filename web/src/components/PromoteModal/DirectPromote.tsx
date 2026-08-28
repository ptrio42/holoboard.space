import { useCallback, useEffect, useRef, useState } from "react";
import { PixelButton } from "../ui/PixelButton";
import { CopyButton } from "../ui/CopyButton";
import { QrCode } from "../ui/QrCode";
import { Spinner } from "../ui/Spinner";
import { checkProgress, requestInvoice, type PromoteInvoice } from "../../lib/promote";
import { formatSats } from "../../lib/nostr";
import { ZAP_PRESETS } from "../../config";

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

const clampSats = (value: number): number => {
    if (!Number.isFinite(value)) return 1;
    return Math.min(MAX_SATS, Math.max(1, Math.floor(value)));
};

type Phase =
    | { kind: "idle" }
    | { kind: "requesting" }
    | { kind: "waiting"; invoice: PromoteInvoice; satsBefore: number }
    | { kind: "paid"; sats: number }
    | { kind: "failed"; message: string };

export function DirectPromote() {
    const [reference, setReference] = useState("");
    const [amount, setAmount] = useState<number>(ZAP_PRESETS[1]);
    const [phase, setPhase] = useState<Phase>({ kind: "idle" });
    const abort = useRef<AbortController | null>(null);

    useEffect(() => () => abort.current?.abort(), []);

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
            const invoice = await requestInvoice(note, amount, abort.current.signal);
            // Remember what the note had before paying. The relay cannot tell a
            // settled invoice from an expired one, since both are simply gone,
            // so the change in this figure is what proves the payment landed.
            let satsBefore = 0;
            try {
                satsBefore = (await checkProgress(invoice.paymentHash, invoice.noteId)).satsPaid;
            } catch {
                // Not knowing the baseline only costs a slightly weaker check.
            }
            setPhase({ kind: "waiting", invoice, satsBefore });
        } catch (error) {
            setPhase({
                kind: "failed",
                message: error instanceof Error ? error.message : "something went wrong",
            });
        }
    }, [reference, amount]);

    // Watch for the payment while a QR code is on screen.
    useEffect(() => {
        if (phase.kind !== "waiting") return;

        const { invoice, satsBefore } = phase;
        let stopped = false;

        const tick = async () => {
            try {
                const progress = await checkProgress(invoice.paymentHash, invoice.noteId);
                if (stopped) return;
                if (!progress.pending && progress.satsPaid > satsBefore) {
                    setPhase({ kind: "paid", sats: progress.satsPaid });
                }
            } catch {
                // A failed poll is not a failed payment. Keep asking.
            }
        };

        const timer = window.setInterval(() => void tick(), POLL_MS);
        return () => {
            stopped = true;
            window.clearInterval(timer);
        };
    }, [phase]);

    if (phase.kind === "paid") {
        return (
            <div className="space-y-3">
                <p className="font-pixel text-[11px] tracking-widest text-neon-gold">Paid.</p>
                <p className="text-xs leading-relaxed text-cyan-100/70">
                    The note is on the board with {formatSats(phase.sats)} sats against it. Pay
                    again any time to move it further up.
                </p>
                <PixelButton onClick={() => setPhase({ kind: "idle" })}>
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
        <div className="space-y-4">
            <p className="text-xs leading-relaxed text-cyan-100/70">
                Paste the note you want promoted and pay the invoice. No extension, no signing in,
                and it works for anyone's note rather than only your own.
            </p>

            <label className="block space-y-1">
                <span className="font-pixel text-[9px] tracking-widest text-cyan-300/50">
                    Note reference
                </span>
                <input
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    placeholder="note1... or nevent1... or a 64 character id"
                    spellCheck={false}
                    className="focus-pixel w-full border-2 border-cyan-400/30 bg-void p-2 text-xs
                        text-cyan-100 placeholder:text-cyan-300/25"
                />
            </label>

            <div className="space-y-1">
                <span className="font-pixel text-[9px] tracking-widest text-cyan-300/50">Amount</span>
                <div className="flex flex-wrap items-center gap-2">
                    {ZAP_PRESETS.map((preset) => (
                        <button
                            key={preset}
                            type="button"
                            aria-pressed={amount === preset}
                            onClick={() => setAmount(preset)}
                            className={`focus-pixel border-2 px-3 py-1 font-pixel text-[10px]
                                ${
                                    amount === preset
                                        ? "border-neon-gold text-neon-gold"
                                        : "border-cyan-400/30 text-cyan-300/60 hover:text-neon-cyan"
                                }`}
                        >
                            {formatSats(preset)}
                        </button>
                    ))}
                    {/* The presets are shortcuts, not the choice. The relay takes
                        anything from 1 sat upwards. */}
                    <label className="flex items-center gap-2">
                        <span className="sr-only">Custom amount in sats</span>
                        <input
                            type="number"
                            min={1}
                            max={MAX_SATS}
                            step={1}
                            value={amount}
                            onChange={(event) =>
                                setAmount(clampSats(Number(event.target.value)))
                            }
                            className="focus-pixel w-28 border-2 border-cyan-400/40 bg-void px-2 py-1
                                text-right text-xs text-cyan-100"
                        />
                        <span className="font-pixel text-[9px] text-cyan-300/60">sats</span>
                    </label>
                </div>
            </div>

            {phase.kind === "failed" && (
                <p className="border-2 border-neon-pink/40 bg-neon-pink/5 p-2 text-xs text-neon-pink">
                    {phase.message}
                </p>
            )}

            <PixelButton
                variant="accent"
                onClick={() => void start()}
                disabled={phase.kind === "requesting"}
            >
                {phase.kind === "requesting"
                    ? "Asking the relay"
                    : `Get invoice, ${formatSats(amount)} sats`}
            </PixelButton>
        </div>
    );
}
