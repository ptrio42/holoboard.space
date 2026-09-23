import { useMemo, useState } from "react";
import { RELAY_PUBKEY, ZAP_PRESETS } from "../../config";
import { formatSats, parseNoteReference, toNeventUri, toNpub } from "../../lib/nostr";
import type { RankingTarget } from "../../lib/ranking";
import { CopyButton } from "../ui/CopyButton";
import { PromotionAmountPicker } from "./PromotionAmountPicker";

const MAX_SATS = 10_000_000;

export function DMPromote({ initialReference = "", currentWeight, rankingTargets }: {
    initialReference?: string;
    currentWeight?: number;
    rankingTargets: RankingTarget[];
}) {
    const [reference, setReference] = useState(initialReference);
    const [amount, setAmount] = useState(ZAP_PRESETS[1]);
    const note = useMemo(() => parseNoteReference(reference), [reference]);
    const command = note ? `PROMOTE ${amount} ${toNeventUri(note)}` : "";
    const relayNpub = toNpub(RELAY_PUBKEY);

    return (
        <section className="space-y-4">
            <p className="text-xs leading-relaxed text-cyan-100/70">
                Promote from any Nostr client that supports private DMs. Send the command below
                to Holoboard and it will answer in the same conversation with a Lightning invoice.
                This route adds ranking weight and preserves any active appearance.
            </p>

            <label className="block space-y-1">
                <span className="font-pixel text-[9px] tracking-widest text-cyan-300/50">Note reference</span>
                <input
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    placeholder="note1..., nevent1..., or a link to the note"
                    spellCheck={false}
                    className="focus-pixel w-full border-2 border-cyan-400/30 bg-void p-2 text-xs
                        text-cyan-100 placeholder:text-cyan-300/25"
                />
            </label>

            <PromotionAmountPicker amount={amount} currentWeight={currentWeight ?? 0} max={MAX_SATS}
                targets={rankingTargets} onChange={setAmount} />

            {reference.trim() && !note && <p role="alert" className="text-xs text-neon-pink">
                That does not look like a note reference.
            </p>}

            {command && <div className="space-y-2">
                <p className="font-pixel text-[9px] tracking-widest text-neon-gold">Send this command</p>
                <div className="flex flex-wrap items-center gap-2">
                    <code className="min-w-0 flex-1 border-2 border-cyan-400/30 bg-void p-2 text-[10px]
                        break-all text-cyan-200/80 select-all">{command}</code>
                    <CopyButton value={command} label="Copy command" />
                </div>
                <p className="text-[11px] text-cyan-300/50">Promotion amount: {formatSats(amount)} sats.</p>
            </div>}

            <div className="space-y-2 border-t-2 border-cyan-400/20 pt-4">
                <p className="font-pixel text-[9px] tracking-widest text-neon-pink">Holoboard npub</p>
                <div className="flex flex-wrap items-center gap-2">
                    <code className="min-w-0 flex-1 border-2 border-cyan-400/30 bg-void p-2 text-[10px]
                        break-all text-cyan-200/80 select-all">{relayNpub}</code>
                    <CopyButton value={relayNpub} label="Copy npub" />
                </div>
                <a href={`nostr:${relayNpub}`} className="focus-pixel inline-block font-pixel text-[9px]
                    tracking-widest text-cyan-300/60 hover:text-neon-cyan">
                    Open Holoboard in a Nostr client
                </a>
            </div>

            <p className="border-2 border-cyan-400/20 bg-void/50 p-3 text-xs leading-relaxed text-cyan-100/65">
                After payment, Holoboard confirms that the promotion is active. Reply YES to that
                message if you want one DM when the note moves to Expired.
            </p>
        </section>
    );
}
