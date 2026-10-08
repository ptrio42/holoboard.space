import { ENABLE_DISCUSSIONS, RELAY_URL } from "../../config";
import { DiscussionLink } from "../ui/DiscussionLink";
import { useId, useMemo, useState, type CSSProperties, type MouseEvent } from "react";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { BillboardConfig } from "../../lib/billboard";
import { formatSats, njumpUrl, parseNoteReference } from "../../lib/nostr";
import { parentOf } from "../../lib/parent";
import { noteAttachments } from "../../lib/noteAttachments";
import { BillboardScreen } from "../BillboardScreen/BillboardScreen";
import TextRenderer from "../TextRenderer/TextRenderer";
import { NoteContent } from "../TextRenderer/NoteContent";
import { UserProfileInline } from "../UserProfileInline/UserProfileInline";
import { Expandable } from "../ui/Expandable";
import { BoostIcon } from "../ui/NoteControls";
import { NotePopover } from "../ui/NotePopover";
import { PixelButton } from "../ui/PixelButton";
import { PixelPanel } from "../ui/PixelPanel";

interface BoardRowProps {
    event: NDKEvent;
    readingFocus?: boolean;
    initiallyExpanded?: boolean;
    initiallyExpandedTexts?: readonly string[];
    billboard?: BillboardConfig;
    billboardPreviewSlide?: number;
    rank?: number;
    expired?: boolean;
    isNew?: boolean;
    onPromote?: () => void;
    lastPaidAt?: number;
    firstPaidAt?: number;
    hotSats?: number;
    /** Undefined means the ledger has not answered, rather than zero paid. */
    sats?: number;
    /** Current ranking weight, including decay. Undefined means unavailable. */
    weight?: number;
}

const TIERS = [
    { accent: "#fbbf24", glow: "rgba(251,191,36,0.35)", text: "text-neon-gold", label: "TOP" },
    { accent: "#22d3ee", glow: "rgba(34,211,238,0.28)", text: "text-neon-cyan" },
    { accent: "#ec4899", glow: "rgba(236,72,153,0.28)", text: "text-neon-pink" },
];
const DEFAULT_TIER = { accent: "rgba(34,211,238,0.32)", glow: undefined, text: "text-cyan-300/60" };

function satsLabel(sats: number): string {
    return `${formatSats(sats)} ${sats === 1 ? "sat" : "sats"}`;
}

function weightLabel(sats: number, weight: number | undefined, expired: boolean): string {
    if (expired) return `${satsLabel(sats)} paid, no longer counting`;
    if (typeof weight !== "number") return `${satsLabel(sats)} paid, current weight unavailable`;
    return `${satsLabel(weight)} counting, ${satsLabel(sats)} paid in total`;
}

function paymentDate(value: number) {
    return <time dateTime={new Date(value * 1000).toISOString()}>{new Date(value * 1000).toLocaleDateString()}</time>;
}

export function BoardRow({ event, readingFocus = false, initiallyExpanded = false, initiallyExpandedTexts, rank, sats, weight, expired = false, isNew = false, onPromote, lastPaidAt, firstPaidAt, hotSats, billboard, billboardPreviewSlide }: BoardRowProps) {
    const tier = !expired && rank ? TIERS[rank - 1] ?? DEFAULT_TIER : DEFAULT_TIER;
    const rankLabel = rank ? TIERS[rank - 1]?.label : undefined;
    const parent = parentOf(event);
    const hasBillboard = !!billboard && !expired;
    const quotedIds = useMemo(() => new Set(noteAttachments(event.content, event.tags, event.id).quotes.map(quote => quote.key)), [event.content, event.tags, event.id]);
    const parentIsQuoted = parent && quotedIds.has(parseNoteReference(parent.href)?.id ?? "");
    const [popup, setPopup] = useState<{ kind: "weight" | "options"; anchor: HTMLButtonElement } | null>(null);
    const [optionsHintDismissed, setOptionsHintDismissed] = useState(false);
    const popupId = useId();
    const openPopup = (kind: "weight" | "options", event: MouseEvent<HTMLButtonElement>) => {
        const anchor = event.currentTarget;
        if (kind === "options") setOptionsHintDismissed(true);
        setPopup(current => current?.kind === kind ? null : { kind, anchor });
    };
    const closePopup = (restoreFocus = true) => {
        if (popup?.kind === "options") setOptionsHintDismissed(true);
        if (restoreFocus) popup?.anchor.focus({ preventScroll: true });
        setPopup(null);
    };
    const fraction = typeof sats === "number" && typeof weight === "number" && sats > 0
        ? Math.max(0, Math.min(1, weight / sats)) : null;
    const displayedSats = expired ? sats : weight ?? sats;
    const wideAmount = typeof displayedSats === "number" && satsLabel(displayedSats).length > 9;
    const position = !expired && <span className={`board-rank ${tier.text}`} aria-label={`Rank ${rank ?? "unavailable"}`}>
        <span className="board-rank__number" aria-hidden="true">{rank ?? "?"}</span>
        {rankLabel && <span className="board-rank__label" aria-hidden="true">{rankLabel}</span>}
    </span>;
    const fullSats = (value: number) => `${new Intl.NumberFormat("en-US").format(value)} sats`;

    return <li data-board-note={readingFocus ? undefined : event.id} data-reading-focus={readingFocus ? event.id : undefined}
        data-discussion-key={readingFocus ? `event:${event.id}` : undefined} id={readingFocus ? `discussion-note-${event.id}` : undefined}
        tabIndex={readingFocus ? -1 : undefined} style={{ marginTop: "var(--reading-gap, 0px)" }}><div className="@container/row">
        <PixelPanel accent={tier.accent} glow={tier.glow}>
            <article aria-label={readingFocus ? "Discussion focus" : undefined} className="board-note board-note--adaptive" style={{ "--rank-accent": tier.accent } as CSSProperties}>
                <Expandable unclamped initiallyExpanded={initiallyExpanded} label={expired ? "expired note" : `note at rank ${rank ?? "unavailable"}`}
                    visibleExpandLabel="Read" collapsedMaxHeight={260}
                    expandLabel={hasBillboard ? "Read original" : "Show more"}
                    collapseLabel={hasBillboard ? "Hide original" : "Show less"}
                    expandedContent={hasBillboard ? <div className="board-original">
                        <p className="font-pixel text-[10px] text-neon-cyan">Original text</p>
                        <TextRenderer text={event.content} embedQuotes={false} previewLinks={false} />
                    </div> : undefined}
                    footer={(control, disclosure) => <>
                        <footer className={`note-footer board-meta${wideAmount ? " board-meta--wide" : ""}${ENABLE_DISCUSSIONS ? " board-meta--discussion" : ""}`}>
                            {!hasBillboard && control && <div className="board-reading">{control}</div>}
                            <div className="board-identity">
                                <h2 className="min-w-0 font-normal">
                                    <span className="sr-only">{expired ? "Expired note" : `Note at rank ${rank ?? "unavailable"}`}, posted by </span>
                                    <UserProfileInline pubkey={event.pubkey} size="compact" />
                                </h2>
                                {isNew && <span className="board-new" aria-label="New since your last visit">New</span>}
                                {parent && <div className="board-context">
                                    {parentIsQuoted ? <span>{parent.label} quoted note</span> : <a href={parent.href}
                                        target="_blank" rel="noopener noreferrer" className="note-context" title="Open conversation context">
                                        {parent.label} <span aria-hidden="true">↗</span>
                                    </a>}
                                </div>}
                            </div>
                            <div className="board-weight-actions">
                                {typeof sats === "number" && <button type="button" className="board-weight focus-pixel"
                                    aria-label={weightLabel(sats, weight, expired)} aria-haspopup="dialog" aria-controls={`${popupId}-weight`}
                                    aria-expanded={popup?.kind === "weight"} onClick={event => openPopup("weight", event)}>
                                    <span aria-hidden="true">{satsLabel(displayedSats ?? sats)}</span>
                                    {!expired && fraction !== null && <span className="board-weight__track" aria-hidden="true">
                                        <span className={fraction === 1 ? "is-full" : undefined} style={{ width: `${fraction * 100}%` }} />
                                    </span>}
                                    {(expired || typeof weight !== "number") && <span className="board-weight__state" aria-hidden="true">{expired ? "Expired" : "paid"}</span>}
                                </button>}
                                {expired && typeof sats !== "number" && <span className="board-weight__state">Expired</span>}
                                {onPromote && <span className="board-hint-wrap"><PixelButton size="sm" variant="ghost" onClick={onPromote}
                                    className="note-boost" aria-label={expired ? "Promote again" : "Boost"}>
                                    <BoostIcon />
                                </PixelButton><span className="board-hint" aria-hidden="true">{expired ? "Promote again" : "Boost"}</span></span>}
                            </div>
                            <div className="board-note-actions">
                                {ENABLE_DISCUSSIONS && !readingFocus && <DiscussionLink compact id={event.id} author={event.pubkey} hints={[RELAY_URL]} seed={event.rawEvent()}
                                    presentation={{ rank, sats, weight, expired, isNew, lastPaidAt, firstPaidAt, hotSats, billboard, billboardPreviewSlide }} />}
                                <span className="board-hint-wrap" data-hint-dismissed={optionsHintDismissed || popup?.kind === "options" || undefined}
                                    onPointerLeave={event => { if (!event.currentTarget.querySelector(":focus-visible")) setOptionsHintDismissed(false); }}
                                    onBlur={() => setOptionsHintDismissed(false)}><button type="button" className="note-icon-control board-options"
                                    aria-label="Note options" aria-haspopup="menu" aria-controls={`${popupId}-options`} aria-expanded={popup?.kind === "options"}
                                    onClick={event => openPopup("options", event)}>
                                    <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" shapeRendering="crispEdges">
                                        <path d="M9 2h3v3H9zM9 9h3v3H9zM9 16h3v3H9z" />
                                    </svg>
                                </button><span className="board-hint" aria-hidden="true">Note options</span></span>
                            </div>
                        </footer>
                        {popup?.kind === "options" && <NotePopover id={`${popupId}-options`} anchor={popup.anchor} title="Note options" menu onClose={closePopup}>
                            <div role="menu" aria-label="Note options" className="note-menu">
                                {hasBillboard && <button type="button" role="menuitem" aria-expanded={disclosure.expanded}
                                    aria-controls={disclosure.controls} onClick={() => { closePopup(); disclosure.toggle(); }}>
                                    {disclosure.expanded ? "Hide original" : "Read original"}
                                </button>}
                                <a role="menuitem" href={njumpUrl(event.id, "note", [RELAY_URL], event.pubkey)} target="_blank" rel="noopener noreferrer nofollow"
                                    onClick={() => closePopup()}>Open in njump</a>
                            </div>
                            {(expired && !!lastPaidAt || !!firstPaidAt || typeof hotSats === "number") && <div className="note-menu__details">
                                {expired && typeof lastPaidAt === "number" && lastPaidAt > 0 && <p>Last payment: {paymentDate(lastPaidAt)}</p>}
                                {typeof firstPaidAt === "number" && firstPaidAt > 0 && <p>First promoted: {paymentDate(firstPaidAt)}</p>}
                                {typeof hotSats === "number" && <p>{satsLabel(hotSats)} for visibility in the last 24 hours</p>}
                            </div>}
                        </NotePopover>}
                    </>}>
                    <div className="board-note-content">{position}<NoteContent text={event.content} tags={event.tags} ownId={event.id} adaptive
                        textPresentation={hasBillboard ? <BillboardScreen config={billboard!} initialSlide={billboardPreviewSlide} sourceContent={event.content} /> : undefined}
                        initiallyExpanded={initiallyExpanded} initiallyExpandedTexts={initiallyExpandedTexts} /></div>
                </Expandable>
                {popup?.kind === "weight" && typeof sats === "number" && <NotePopover id={`${popupId}-weight`} anchor={popup.anchor} title="Ranking weight" onClose={closePopup}>
                    <dl className="board-weight-details">
                        <div><dt>Counting today</dt><dd>{expired ? "No longer counting" : typeof weight === "number" ? fullSats(weight) : "Unavailable"}</dd></div>
                        <div><dt>Paid for visibility</dt><dd>{fullSats(sats)}</dd></div>
                        {!expired && fraction !== null && <div><dt>Remaining weight</dt><dd>{Math.round(fraction * 100)}% still counts</dd></div>}
                    </dl>
                    <p className="note-popover__help">{expired ? "This promotion has expired. A new promotion adds fresh ranking weight."
                        : typeof weight !== "number" ? "The total paid is available. The current ranking weight has not loaded yet."
                        : "Each payment keeps half its ranking weight after 30 days. Boosts add fresh weight."}</p>
                </NotePopover>}
            </article>
        </PixelPanel>
    </div></li>;
}
