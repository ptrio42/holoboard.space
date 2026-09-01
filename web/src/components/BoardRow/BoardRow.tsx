import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { PixelPanel } from "../ui/PixelPanel";
import { UserProfileInline } from "../UserProfileInline/UserProfileInline";
import TextRenderer from "../TextRenderer/TextRenderer";
import { Expandable } from "../ui/Expandable";
import { formatSats, njumpUrl } from "../../lib/nostr";
import { isoDate, timeAgo } from "../../lib/time";

interface BoardRowProps {
    event: NDKEvent;
    rank: number;
    /**
     * What this note has been paid. Undefined means the ledger has not answered
     * yet, which is not the same as zero and must not render as zero: every
     * note on this board was paid for, that is how it got here.
     */
    sats?: number;
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
const DEFAULT_TIER = { accent: "rgba(34,211,238,0.32)", glow: undefined, text: "text-cyan-300/60" };

/** "1 sat", but "2 sats" and "2.1k sats". */
function satsLabel(sats: number): string {
    return `${formatSats(sats)} ${sats === 1 ? "sat" : "sats"}`;
}

export function BoardRow({ event, rank, sats }: BoardRowProps) {
    const tier = TIERS[rank - 1] ?? DEFAULT_TIER;
    const created = event.created_at ?? 0;

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
                                    <span
                                        className={`font-pixel text-[9px] tracking-wider ${tier.text}`}
                                        title={`${sats.toLocaleString()} sats paid`}
                                        aria-hidden="true"
                                    >
                                        {satsLabel(sats)}
                                    </span>
                                )}
                                {created > 0 && (
                                    <time
                                        dateTime={isoDate(created)}
                                        className="font-pixel text-[9px] text-cyan-300/35"
                                    >
                                        {timeAgo(created)}
                                    </time>
                                )}
                            </div>
                        </div>

                        <div className="text-[13px] text-cyan-50/80 sm:text-sm">
                            <Expandable label={`note at rank ${rank}`}>
                                <TextRenderer text={event.content} />
                            </Expandable>
                        </div>

                        <a
                            href={njumpUrl(event.id, "note")}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="focus-pixel inline-block font-pixel text-[9px] tracking-widest
                                text-cyan-300/40 hover:text-neon-cyan"
                        >
                            Open note
                        </a>
                    </div>
                </article>
            </PixelPanel>
        </li>
    );
}
