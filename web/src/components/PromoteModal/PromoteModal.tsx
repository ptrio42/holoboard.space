import { useId, useState } from "react";
import { useNDKCurrentUser } from "@nostr-dev-kit/react";
import { Modal } from "../ui/Modal";
import { PixelButton, PixelLink } from "../ui/PixelButton";
import { CopyButton } from "../ui/CopyButton";
import { QrCode } from "../ui/QrCode";
import { Spinner } from "../ui/Spinner";
import { LoginButton } from "../LoginButton/LoginButton";
import { usePromotionFlow, type Stage } from "./usePromotionFlow";
import { RELAY_PUBKEY, RELAY_URL, ZAP_PRESETS } from "../../config";
import { formatSats, toNpub } from "../../lib/nostr";

interface PromoteModalProps {
    onClose: () => void;
}

const STEPS: { key: string; label: string; stages: Stage[] }[] = [
    { key: "mention", label: "Mention", stages: ["compose", "publishing"] },
    { key: "reply", label: "Reply", stages: ["awaiting-reply"] },
    { key: "zap", label: "Zap", stages: ["choose-amount", "invoice", "paid"] },
];

/** Rendered only while open; closing unmounts it, which is what clears the flow. */
export function PromoteModal({ onClose }: PromoteModalProps) {
    const user = useNDKCurrentUser();
    const { state, submitNote, zapReply } = usePromotionFlow();
    const [reference, setReference] = useState("");
    const [amount, setAmount] = useState<number>(ZAP_PRESETS[1]);
    const inputId = useId();

    const busy = state.stage === "publishing" || state.stage === "awaiting-reply";
    const activeStep = STEPS.findIndex((step) => step.stages.includes(state.stage));

    return (
        <Modal isOpen onClose={onClose} title="Promote a note">
            <div className="space-y-6 text-sm text-cyan-100/85">
                <ol className="flex items-center gap-2 font-pixel text-[9px] tracking-widest">
                    {STEPS.map((step, index) => (
                        <li key={step.key} className="flex items-center gap-2">
                            <span
                                className={
                                    index < activeStep
                                        ? "text-neon-cyan"
                                        : index === activeStep
                                          ? "text-neon-gold"
                                          : "text-cyan-300/30"
                                }
                            >
                                {index + 1}. {step.label}
                            </span>
                            {index < STEPS.length - 1 && <span className="text-cyan-300/25">&gt;</span>}
                        </li>
                    ))}
                </ol>

                <p aria-live="polite" className="sr-only">
                    {stageAnnouncement(state.stage)}
                </p>

                {state.error && (
                    <p
                        role="alert"
                        className="border-2 border-neon-pink/60 bg-pink-950/30 p-3 leading-relaxed text-pink-200"
                    >
                        {state.error}
                    </p>
                )}

                {(state.stage === "compose" || busy) && (
                    <section className="space-y-4">
                        <p className="leading-relaxed">
                            Point at any note on Nostr. Holoboard mentions it for you, the relay
                            answers with a promotional reply, and zapping that reply is what puts the
                            note on the board. Rank is total sats, nothing else.
                        </p>

                        {!user ? (
                            <div className="flex flex-col items-start gap-3 border-2 border-cyan-400/30 p-4">
                                <p className="font-pixel text-[10px] leading-relaxed text-neon-gold">
                                    Connect a signer to continue
                                </p>
                                <LoginButton />
                            </div>
                        ) : (
                            <form
                                className="space-y-3"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    void submitNote(reference);
                                }}
                            >
                                <label
                                    htmlFor={inputId}
                                    className="block font-pixel text-[10px] tracking-widest text-neon-pink"
                                >
                                    Note to promote
                                </label>
                                <input
                                    id={inputId}
                                    value={reference}
                                    onChange={(event) => setReference(event.target.value)}
                                    disabled={busy}
                                    spellCheck={false}
                                    autoComplete="off"
                                    placeholder="note1... / nevent1... / 64-char id / njump link"
                                    aria-describedby={`${inputId}-hint`}
                                    className="focus-pixel w-full border-2 border-cyan-400/40 bg-void px-3 py-3
                                        text-cyan-100 placeholder:text-cyan-300/30 disabled:opacity-50"
                                />
                                <p id={`${inputId}-hint`} className="text-xs text-cyan-300/50">
                                    Anyone can promote anyone's note. It does not have to be yours.
                                </p>
                                <div className="flex items-center gap-3">
                                    <PixelButton type="submit" disabled={busy || !reference.trim()}>
                                        {state.stage === "publishing" ? "Publishing..." : "Promote"}
                                    </PixelButton>
                                    {busy && (
                                        <span className="flex items-center gap-2 text-xs text-cyan-300/70">
                                            <Spinner label="Working" />
                                            {state.stage === "awaiting-reply"
                                                ? "Waiting for the relay to answer"
                                                : "Signing and publishing"}
                                        </span>
                                    )}
                                </div>
                            </form>
                        )}
                    </section>
                )}

                {state.stage === "choose-amount" && state.reply && (
                    <section className="space-y-4">
                        <div className="border-2 border-cyan-400/30 bg-void/60 p-4">
                            <p className="mb-2 font-pixel text-[9px] tracking-widest text-neon-gold">
                                The relay answered
                            </p>
                            <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-cyan-100/70">
                                {state.reply.content.trim()}
                            </p>
                        </div>

                        <fieldset className="space-y-3">
                            <legend className="font-pixel text-[10px] tracking-widest text-neon-pink">
                                How many sats
                            </legend>
                            <div className="flex flex-wrap gap-2">
                                {ZAP_PRESETS.map((preset) => (
                                    <PixelButton
                                        key={preset}
                                        size="sm"
                                        variant={amount === preset ? "accent" : "ghost"}
                                        aria-pressed={amount === preset}
                                        onClick={() => setAmount(preset)}
                                    >
                                        {formatSats(preset)}
                                    </PixelButton>
                                ))}
                                <label className="flex items-center gap-2">
                                    <span className="sr-only">Custom amount in sats</span>
                                    <input
                                        type="number"
                                        min={1}
                                        step={1}
                                        value={amount}
                                        onChange={(event) =>
                                            setAmount(Math.max(1, Number(event.target.value) || 1))
                                        }
                                        className="focus-pixel w-28 border-2 border-cyan-400/40 bg-void px-2 py-2
                                            text-right text-cyan-100"
                                    />
                                    <span className="font-pixel text-[9px] text-cyan-300/60">sats</span>
                                </label>
                            </div>
                        </fieldset>

                        <PixelButton variant="accent" onClick={() => void zapReply(amount)}>
                            Zap {formatSats(amount)} sats
                        </PixelButton>
                    </section>
                )}

                {state.stage === "invoice" && (
                    <section className="space-y-4">
                        <p className="font-pixel text-[10px] leading-relaxed text-neon-gold">
                            Pay {formatSats(state.amountSats ?? 0)} sats
                        </p>
                        {state.invoice ? (
                            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                                <QrCode value={state.invoice} label="Lightning invoice QR code" />
                                <div className="w-full space-y-3">
                                    <code className="block max-h-24 overflow-y-auto border-2 border-cyan-400/30 bg-void p-2
                                        text-[10px] break-all text-cyan-200/80 select-all">
                                        {state.invoice}
                                    </code>
                                    <div className="flex flex-wrap gap-2">
                                        <CopyButton value={state.invoice} label="Copy invoice" />
                                        <PixelLink href={`lightning:${state.invoice}`} size="sm">
                                            Open in wallet
                                        </PixelLink>
                                    </div>
                                    <p className="flex items-center gap-2 text-xs text-cyan-300/70">
                                        <Spinner label="Waiting for payment" />
                                        Waiting for the zap receipt
                                    </p>
                                </div>
                            </div>
                        ) : (
                            <p className="flex items-center gap-2 text-xs text-cyan-300/70">
                                <Spinner label="Fetching invoice" /> Asking the relay's wallet for an invoice
                            </p>
                        )}
                    </section>
                )}

                {state.stage === "paid" && (
                    <section className="space-y-4">
                        <p className="font-pixel text-xs leading-relaxed text-neon-gold">Paid</p>
                        <p className="leading-relaxed">
                            The zap receipt landed. The relay books the sats and the note joins the
                            board at its new rank. Refresh in a moment if it is not there yet.
                        </p>
                        <PixelButton onClick={onClose}>Back to the board</PixelButton>
                    </section>
                )}

                <details className="disclosure border-t-2 border-cyan-400/20 pt-4">
                    <summary className="focus-pixel cursor-pointer font-pixel text-[10px] tracking-widest
                        text-cyan-300/70 hover:text-neon-cyan">
                        Other ways to promote
                    </summary>
                    <div className="mt-4 space-y-4 text-xs leading-relaxed">
                        <div>
                            <p className="mb-1 font-pixel text-[9px] tracking-widest text-neon-pink">
                                Mention the relay from any client
                            </p>
                            <p className="text-cyan-100/70">
                                This is the flow above, done by hand. Write a note that tags the
                                relay's npub, below, and contains the note you want promoted. The
                                relay answers with a promotional reply; zap that reply to put the
                                note on the board. No keyword is needed, only the reference, and
                                every client lets you tag someone in a note, which is not true of
                                zap comments.
                            </p>
                        </div>
                        <div>
                            <p className="mb-1 font-pixel text-[9px] tracking-widest text-neon-pink">
                                Zap the relay directly
                            </p>
                            <p className="text-cyan-100/70">
                                Zap the relay's pubkey from any client and put the note reference in
                                the zap comment. <code>nostr:nevent1...</code>, <code>note1...</code>{" "}
                                and a bare 64-character id all work.
                            </p>
                        </div>
                        <div>
                            <p className="mb-1 font-pixel text-[9px] tracking-widest text-neon-pink">
                                DM the relay
                            </p>
                            <p className="text-cyan-100/70">
                                Send <code>PROMOTE &lt;note id&gt;</code> as a direct message and the
                                relay answers with a Lightning invoice.
                            </p>
                        </div>
                        <dl className="space-y-3">
                            <div>
                                <dt className="mb-1 text-cyan-300/50">Relay pubkey</dt>
                                <dd className="flex flex-wrap items-center gap-2">
                                    <code className="border-2 border-cyan-400/30 bg-void p-2 text-[10px] break-all
                                        text-cyan-200/80 select-all">
                                        {toNpub(RELAY_PUBKEY)}
                                    </code>
                                    <CopyButton value={toNpub(RELAY_PUBKEY)} />
                                </dd>
                            </div>
                            <div>
                                <dt className="mb-1 text-cyan-300/50">Relay URL</dt>
                                <dd className="flex flex-wrap items-center gap-2">
                                    <code className="border-2 border-cyan-400/30 bg-void p-2 text-[10px] break-all
                                        text-cyan-200/80 select-all">
                                        {RELAY_URL}
                                    </code>
                                    <CopyButton value={RELAY_URL} />
                                </dd>
                            </div>
                        </dl>
                    </div>
                </details>
            </div>
        </Modal>
    );
}

function stageAnnouncement(stage: Stage): string {
    switch (stage) {
        case "publishing":
            return "Publishing the mention.";
        case "awaiting-reply":
            return "Waiting for the relay to reply.";
        case "choose-amount":
            return "The relay replied. Choose an amount to zap.";
        case "invoice":
            return "Invoice ready. Waiting for payment.";
        case "paid":
            return "Payment received.";
        default:
            return "";
    }
}
