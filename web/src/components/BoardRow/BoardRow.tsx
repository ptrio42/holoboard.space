import { useState } from "react";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { PixelPanel } from "../ui/PixelPanel";
import { UserProfileInline } from "../UserProfileInline/UserProfileInline";
import TextRenderer from "../TextRenderer/TextRenderer";
import { Expandable } from "../ui/Expandable";
import { formatSats, njumpUrl } from "../../lib/nostr";
import { parentOf } from "../../lib/parent";

interface BoardRowProps {
    event: NDKEvent;
    rank: number;
    /**
     * What this note has been paid. Undefined means the ledger has not answered
     * yet, which is not the same as zero and must not render as zero: every
     * note on this board was paid for, that is how it got here.
     */
    sats?: number;
    /**
     * What those sats are worth today. The board is ordered by this rather than
     * by sats, because a payment fades, so a note with fewer sats can sit
     * higher. Undefined means the ledger has not answered yet.
     */
    weight?: number;
}

/**
 * Rank is the only thing this board knows, so rank is what the row is built
 * around. The top three get their own colour; everything below shares a dim
 * frame, which is what makes the top of the list read as the top of the list.
 */
const TIERS = [
    { accent: "#fbbf24", glow: "rgba(251,191,36,0.35)", text: "text-neon-gold" },
    { accent: "#22d3ee", glow: "rgba(34,211,238,0.28)", text: "text-neon-cyan" },
    { accent: "#ec4899", glow: "rgba(236,72,153,0.28)", text: "text-neon-pink" },
];
/** Blocks in the fade meter. Coarse on purpose: it is read, not measured. */
const METER_BLOCKS = 5;

const DEFAULT_TIER = { accent: "rgba(34,211,238,0.32)", glow: undefined, text: "text-cyan-300/60" };

/**
 * The whole story for a screen reader, which has neither hover nor a bar.
 */
function weightLabel(sats: number, weight: number | undefined, faded: boolean): string {
    if (!faded || typeof weight !== "number") return `${satsLabel(sats)} paid`;
    return `${satsLabel(sats)} paid, worth ${satsLabel(weight)} today`;
}

/** "1 sat", but "2 sats" and "2.1k sats". */
function satsLabel(sats: number): string {
    return `${formatSats(sats)} ${sats === 1 ? "sat" : "sats"}`;
}

export function BoardRow({ event, rank, sats, weight }: BoardRowProps) {
    const tier = TIERS[rank - 1] ?? DEFAULT_TIER;
    const parent = parentOf(event);
    // Tapped open on a touch screen, which has no hover to ask with.
    const [showWeight, setShowWeight] = useState(false);

    /*
     * How much of what was paid still counts. Shown as a bar rather than a
     * second number, because the bar answers "why is this here" at a glance and
     * a number would need explaining. The figures behind it stay in the markup
     * for anyone who wants them, and for a screen reader, which has no hover.
     */
    const fresh = typeof sats === "number" && typeof weight === "number" && sats > 0
        ? Math.max(0, Math.min(1, weight / sats))
        : null;
    // One rule, not two. Deciding whether to draw the meter separately from how
    // many of its blocks to fill let a note round up to a full one, which is
    // the case the meter is meant never to appear in.
    const litBlocks = fresh === null ? null : Math.round(fresh * METER_BLOCKS);
    const faded = litBlocks !== null && litBlocks < METER_BLOCKS;

    return (
        <li>
            <PixelPanel accent={tier.accent} glow={tier.glow}>
                <article className="flex gap-3 p-4 sm:gap-5 sm:p-5">
                    {/* Fixed width so the content column does not step right at rank 10. */}
                    <div className="flex w-9 shrink-0 flex-col items-center gap-1 sm:w-12">
                        <span
                            className={`font-pixel text-lg leading-none sm:text-2xl ${tier.text}`}
                            aria-hidden="true"
                        >
                            {rank}
                        </span>
                        <span className="font-pixel text-[8px] tracking-widest text-cyan-300/30">
                            {rank === 1 ? "TOP" : "RANK"}
                        </span>
                    </div>

                    <div className="min-w-0 flex-1 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <h2 className="min-w-0 text-base font-normal">
                                <span className="sr-only">
                                    Rank {rank}
                                    {typeof sats === "number" && `, paid ${satsLabel(sats)}`}, posted by{" "}
                                </span>
                                <UserProfileInline pubkey={event.pubkey} />
                            </h2>
                            <div className="flex shrink-0 items-center gap-3">
                                {typeof sats === "number" && (
                                    <button
                                        type="button"
                                        onClick={() => setShowWeight((open) => !open)}
                                        aria-expanded={showWeight}
                                        aria-label={weightLabel(sats, weight, faded)}
                                        className={`focus-pixel group relative flex items-center gap-2
                                            ${tier.text}`}
                                    >
                                        <span className="font-pixel text-[9px] tracking-wider" aria-hidden="true">
                                            {satsLabel(sats)}
                                        </span>

                                        {/* Only once something has gone. A full meter says
                                            nothing, and drawn as one line it reads as a dash. */}
                                        {faded && (
                                            <span aria-hidden="true" className="flex items-center gap-px">
                                                {Array.from({ length: METER_BLOCKS }, (_, i) => (
                                                    <span
                                                        key={i}
                                                        className={`h-2 w-1 ${
                                                            i < (litBlocks ?? 0)
                                                                ? "bg-current"
                                                                : "bg-cyan-400/30"
                                                        }`}
                                                    />
                                                ))}
                                            </span>
                                        )}

                                        {/* Under the cluster rather than beside it, so the row does
                                            not grow a second column of numbers that is usually not
                                            there, and not above it: the header sits against the top
                                            of the panel, with no room to put anything over it. */}
                                        {faded && (
                                            <span
                                                role="tooltip"
                                                className={`pointer-events-none absolute top-full right-0 z-10 mt-2
                                                    border-2 border-cyan-400/40 bg-void px-2 py-1 font-pixel
                                                    text-[9px] whitespace-nowrap text-cyan-200/90
                                                    ${showWeight ? "block" : "hidden group-hover:block"}`}
                                            >
                                                {formatSats(weight ?? 0)} of {formatSats(sats)} still counting
                                            </span>
                                        )}
                                    </button>
                                )}
                            </div>
                        </div>

                        <div className="text-[13px] text-cyan-50/80 sm:text-sm">
                            <Expandable label={`note at rank ${rank}`}>
                                <TextRenderer text={event.content} />
                            </Expandable>
                        </div>

                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                            <a
                                href={njumpUrl(event.id, "note")}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="focus-pixel inline-block font-pixel text-[9px] tracking-widest
                                    text-cyan-300/40 hover:text-neon-cyan"
                            >
                                Open note
                            </a>
                            {/* Without this a comment reads as somebody talking
                                to nobody, since what it answers is not here. */}
                            {parent && (
                                <a
                                    href={parent.href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="focus-pixel inline-block font-pixel text-[9px] tracking-widest
                                        text-cyan-300/40 hover:text-neon-cyan"
                                >
                                    {parent.label} &gt;
                                </a>
                            )}
                        </div>
                    </div>
                </article>
            </PixelPanel>
        </li>
    );
}
