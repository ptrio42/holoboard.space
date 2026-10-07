import type { BillboardConfig } from "../../lib/billboard";
import { BillboardScreen } from "../BillboardScreen/BillboardScreen";
import { NoteAttachments } from "../TextRenderer/NoteAttachments";
import { useMemo, useState } from "react";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { PixelPanel } from "../ui/PixelPanel";
import { UserProfileInline } from "../UserProfileInline/UserProfileInline";
import TextRenderer from "../TextRenderer/TextRenderer";
import { Expandable } from "../ui/Expandable";
import { formatSats, njumpUrl, parseNoteReference } from "../../lib/nostr";
import { parentOf } from "../../lib/parent";
import { noteAttachments } from "../../lib/noteAttachments";
import { NoteExternalLink } from "../ui/NoteControls";
import { PixelButton } from "../ui/PixelButton";

interface BoardRowProps {
    event: NDKEvent;
    billboard?: BillboardConfig;
    billboardPreviewSlide?: number;
    rank?: number;
    expired?: boolean;
    isNew?: boolean;
    onPromote?: () => void;
    lastPaidAt?: number;
    firstPaidAt?: number;
    hotSats?: number;
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
function weightLabel(sats: number, weight: number | undefined, expired: boolean): string {
    if (expired) return `${satsLabel(sats)} paid, no longer counting`;
    if (typeof weight !== "number") return `${satsLabel(sats)} paid, current weight unavailable`;
    return `${satsLabel(weight)} counting, ${satsLabel(sats)} paid in total`;
}

/** "1 sat", but "2 sats" and "2.1k sats". */
function satsLabel(sats: number): string {
    return `${formatSats(sats)} ${sats === 1 ? "sat" : "sats"}`;
}

export function BoardRow({ event, rank, sats, weight, expired = false, isNew = false, onPromote, lastPaidAt, firstPaidAt, hotSats, billboard, billboardPreviewSlide }: BoardRowProps) {
    const tier = !expired && rank ? TIERS[rank - 1] ?? DEFAULT_TIER : DEFAULT_TIER;
    const parent = parentOf(event);
    const hasBillboard = !!billboard && !expired;
    const quotedIds = useMemo(() => new Set(noteAttachments(event.content, event.tags, event.id).quotes.map(quote => quote.key)), [event.content, event.tags, event.id]);
    const parentIsQuoted = parent && quotedIds.has(parseNoteReference(parent.href)?.id ?? "");
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
    const hasHistoricalTotal = typeof weight === "number" && typeof sats === "number" && weight < sats;
    // Active rows lead with the number that actually sets their position. The
    // archive still leads with historical sats because nothing counts there.
    const displayedSats = expired ? sats : weight ?? sats;

    return (
        <li>
            <div className="@container/row">
            <PixelPanel accent={tier.accent} glow={tier.glow}>
                <article className="flex gap-3 p-4 @xl/row:gap-5 @xl/row:p-5">
                    {/* Fixed width so the content column does not step right at rank 10. */}
                    {!expired && <div className="flex w-10 shrink-0 flex-col items-center gap-1 @xl/row:w-12">
                        <span
                            className={`font-pixel text-lg leading-none @xl/row:text-2xl ${tier.text}`}
                            aria-hidden="true"
                        >
                            {rank ?? "?"}
                        </span>
                        <span className="font-pixel text-[10px] text-cyan-200/80">
                            {rank === 1 ? "TOP" : "RANK"}
                        </span>
                    </div>}

                    <div className="min-w-0 flex-1 space-y-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                                <h2 className="min-w-0 text-base font-normal">
                                    <span className="sr-only">
                                        {expired ? "Expired note" : `Rank ${rank}`}
                                        {typeof sats === "number" && `, paid ${satsLabel(sats)}`}, posted by{" "}
                                    </span>
                                    <UserProfileInline pubkey={event.pubkey} />
                                </h2>
                                {parent && <div className="mt-1 text-xs text-cyan-100/75">
                                    {parentIsQuoted ? <span>{parent.label} quoted note</span> : <a
                                        href={parent.href} target="_blank" rel="noopener noreferrer"
                                        className="note-context" title="Open conversation context">
                                        {parent.label} <span aria-hidden="true">↗</span>
                                    </a>}
                                </div>}
                            </div>
                            <div className="flex min-h-7 shrink-0 items-center gap-3">
                                {isNew && <span className="font-pixel text-[10px] text-neon-gold" aria-label="New since your last visit">New</span>}
                                {expired && <span className="font-pixel text-[10px] text-cyan-200/80">Expired</span>}
                                {typeof sats === "number" && (
                                    <button
                                        type="button"
                                        onClick={() => setShowWeight((open) => !open)}
                                        aria-expanded={showWeight}
                                        aria-label={weightLabel(sats, weight, expired)}
                                        className={`focus-pixel group relative flex items-center gap-2
                                            ${tier.text}`}
                                    >
                                        <span className="font-pixel text-[9px] tracking-wider" aria-hidden="true">
                                            {satsLabel(displayedSats ?? sats)}
                                        </span>

                                        {/* Only once something has gone. A full meter says
                                            nothing, and drawn as one line it reads as a dash.
                                            Lit blocks are solid and spent ones are hollow, since
                                            telling them apart by brightness alone left an empty
                                            meter looking much like a full one. */}
                                        {faded && (
                                            <span aria-hidden="true" className="flex items-center gap-px">
                                                {Array.from({ length: METER_BLOCKS }, (_, i) => (
                                                    <span
                                                        key={i}
                                                        className={`h-2 w-2 ${
                                                            i < (litBlocks ?? 0)
                                                                ? "bg-current"
                                                                : "border border-cyan-400/30"
                                                        }`}
                                                    />
                                                ))}
                                            </span>
                                        )}

                                        {/* Under the cluster rather than beside it, so the row does
                                            not grow a second column of numbers that is usually not
                                            there, and not above it: the header sits against the top
                                            of the panel, with no room to put anything over it.
                                            It hangs off the left on a narrow screen: a long author
                                            name pushes this cluster onto its own line at the left
                                            edge, and anchoring right then ran it off the screen. */}
                                        {hasHistoricalTotal && (
                                            <span
                                                role="tooltip"
                                                className={`pointer-events-none absolute top-full left-0 z-10 mt-2
                                                    max-w-[min(16rem,calc(100vw-3rem))] border-2 border-cyan-400/40
                                                    bg-void px-2 py-1 font-pixel text-[9px] text-cyan-200/90
                                                    @xl/row:left-auto @xl/row:right-0 @xl/row:whitespace-nowrap
                                                    ${showWeight ? "block" : "hidden group-hover:block"}`}
                                            >
                                                {formatSats(weight ?? 0)} of {formatSats(sats)} still counting
                                            </span>
                                        )}
                                    </button>
                                )}
                            </div>
                        </div>

                        {hasBillboard && <BillboardScreen config={billboard!} initialSlide={billboardPreviewSlide} sourceContent={event.content} />}
                        <Expandable label={expired ? "expired note" : `note at rank ${rank}`}
                            expandLabel={hasBillboard ? "Show original" : "Show more"}
                            collapseLabel={hasBillboard ? "Hide original" : "Show less"}
                            expandedContent={hasBillboard ? <div className="mt-3 border-t border-cyan-400/15 pt-3 text-[13px] text-cyan-50/80 @xl/row:text-sm">
                                <p className="mb-2 text-xs text-cyan-100/75">Original text</p>
                                <TextRenderer text={event.content} embedQuotes={false} previewLinks={false} />
                            </div> : undefined}
                            footer={control => <>
                                {expired && typeof lastPaidAt === "number" && lastPaidAt > 0 && <p className="mt-3 text-xs text-cyan-200/75">
                                    Last payment: <time dateTime={new Date(lastPaidAt * 1000).toISOString()}>{new Date(lastPaidAt * 1000).toLocaleDateString()}</time>
                                </p>}
                                {typeof hotSats === "number" && <p className="mt-3 text-xs text-cyan-300/60">{satsLabel(hotSats)} for visibility in the last 24 hours</p>}
                                {typeof firstPaidAt === "number" && firstPaidAt > 0 && <p className="mt-3 text-xs text-cyan-300/60">First promoted: <time dateTime={new Date(firstPaidAt * 1000).toISOString()}>{new Date(firstPaidAt * 1000).toLocaleDateString()}</time></p>}
                                <div className="note-footer">
                                    {control}
                                    <div className="ml-auto flex shrink-0 items-center gap-5">
                                        <NoteExternalLink href={njumpUrl(event.id, "note")} />
                                        {onPromote && <PixelButton size="sm" variant="ghost" onClick={onPromote} className="note-boost">
                                            {expired ? "Promote again" : "Boost"}
                                        </PixelButton>}
                                    </div>
                                </div>
                            </>}>
                            {hasBillboard ? <NoteAttachments content={event.content} tags={event.tags} ownId={event.id} /> :
                                <div className="text-[13px] text-cyan-50/80 @xl/row:text-sm">
                                    <TextRenderer text={event.content} tags={event.tags} ownId={event.id} />
                                </div>}
                        </Expandable>
                    </div>
                </article>
            </PixelPanel>
            </div>
        </li>
    );
}
