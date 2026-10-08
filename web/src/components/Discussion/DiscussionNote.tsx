import type { Event } from "nostr-tools";
import type { ThreadNode } from "../../lib/threadGraph";
import { njumpUrl, shortNpub } from "../../lib/nostr";
import { NoteContent } from "../TextRenderer/NoteContent";
import { UserProfileInline } from "../UserProfileInline/UserProfileInline";
import { NoteExternalLink } from "../ui/NoteControls";
import { DiscussionLink } from "../ui/DiscussionLink";
import { PixelPanel } from "../ui/PixelPanel";
import { useProfileValue } from "../../hooks/useProfile";
import { discussionHref } from "../../lib/discussionView";
import { navigateReading } from "../../lib/discussionNavigation";
import { parseContent } from "../../utils/textProcessing/parseContent";
import { linkLabel } from "../../lib/noteAttachments";

export function DiscussionNote({ node, event, parent, parentEvent, hints = [], parentHints = [], onParent, focus = false, promoted = false, compact = false, parentIsFocus = false, onReply, branch }: {
    node?: ThreadNode; event?: Event; parent?: ThreadNode; parentEvent?: Event; onParent?: () => void;
    hints?: string[]; parentHints?: string[];
    focus?: boolean; promoted?: boolean; compact?: boolean; parentIsFocus?: boolean; onReply?: () => void;
    branch?: { count: number; expanded: boolean; toggle: () => void };
}) {
    const parentProfile = useProfileValue(parent?.event?.pubkey, parentHints);
    const parentName = parent?.event && (parentProfile?.displayName?.trim() || parentProfile?.name?.trim() || shortNpub(parent.event.pubkey));
    const parentPreview = (!compact || !parentIsFocus) && parentEvent && parseContent(parentEvent.content).map(token =>
        token.kind === "text" ? token.value : token.kind === "mention" ? `${token.bech32.slice(0, 12)}...` :
            token.kind === "link" ? linkLabel(token.href) : token.kind === "image" ? "[Image]" : "[Video]"
    ).join("").replace(/\s+/g, " ").trim().slice(0, 160);
    const date = node?.event && new Date(node.event.created_at * 1000);
    const validDate = date && Number.isFinite(date.getTime());
    const footer = (control?: React.ReactNode) => <footer className="discussion-actions">
        {control}
        {onReply && <button type="button" className="note-action inline-flex min-h-11 items-center" onClick={onReply}>Reply</button>}
        {event && !focus && <DiscussionLink id={event.id} author={event.pubkey} hints={hints} seed={event} label="Thread" accessibleLabel="Open thread" />}
        {node?.reference.type === "event" && <NoteExternalLink href={njumpUrl(node.reference.value, "note", hints, event?.pubkey)} />}
        {validDate && <time className="discussion-time" dateTime={date.toISOString()} title={date.toLocaleString()}>{date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time>}
    </footer>;
    const article = <article className={`discussion-note ${compact ? "discussion-note-compact" : "p-3 sm:p-5"} ${promoted ? "discussion-note-promoted" : ""}`} aria-label={focus ? "Discussion focus" : undefined}>
        <header className="discussion-note__header">
            {node?.event ? <UserProfileInline pubkey={node.event.pubkey} hints={hints} size="compact" /> : <span className="font-pixel text-[10px] text-cyan-100">Missing context</span>}
            {promoted && <span className="discussion-promotion">Promoted</span>}
            {branch && <button type="button" className="note-action inline-flex min-h-11 min-w-11 items-center justify-center gap-1"
                aria-label={branch.expanded ? "Hide replies" : `Show replies (${branch.count})`} title={branch.expanded ? "Hide replies" : `Show replies (${branch.count})`}
                aria-expanded={branch.expanded} onClick={branch.toggle}>
                <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="currentColor" shapeRendering="crispEdges">
                    <path d={branch.expanded ? "M0 4h10v2H0z" : "M4 0h2v4h4v2H6v4H4V6H0V4h4z"} />
                </svg><span aria-hidden="true">{branch.count}</span>
            </button>}
        </header>
        <div className="discussion-note__content">
            {parent?.event && <a href={discussionHref(parent.event.id, parent.event.pubkey, window.location.pathname + window.location.search, parentHints)}
                onClick={event => { if (!onParent) return navigateReading(event); if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onParent(); }}
                className="discussion-parent focus-pixel"
                aria-label={`Go to parent note by ${parentName}`}>
                <span className="flex min-w-0 items-center gap-2"><svg aria-hidden="true" className="shrink-0 text-cyan-400/60" width="10" height="10" viewBox="0 0 10 10" fill="currentColor" shapeRendering="crispEdges"><path d="M0 0h2v4h4V2h2v2h2v2H8v2H6V6H0V0Z" /></svg>
                    <span className="truncate">Replying to <span className="text-cyan-200">{parentName}</span></span>
                </span>
                {parentPreview && <span data-parent-preview className="mt-0.5 line-clamp-1 break-all pl-[18px] text-cyan-100/55">{parentPreview}</span>}
            </a>}
            {node && !["none", "resolved"].includes(node.parentState) && <p className="my-2 text-xs text-cyan-100/75">
                {node.parentState === "missing" ? "Parent not found yet. This branch keeps its original reference." : node.parentState === "external" ? "Replies refer to an external context." : "The parent relationship could not be resolved safely."}
            </p>}
            {node && ["invalid", "conflict", "unresolved", "budget", "depth-limit"].includes(node.rootState) && <p className="my-2 text-xs text-cyan-100/75">Root context remains unresolved.</p>}
            {event ? <><NoteContent text={event.content} tags={event.tags} ownId={event.id} embedQuotes={false} previewLinks={false} />{footer()}</> : <>
                <p className="my-2 break-words text-sm text-cyan-100/75">{node?.event ? "Content is unavailable in the read cache." : "This referenced note has not been found. Other replies remain available."}</p>
                {footer()}
            </>}
        </div>
    </article>;
    return compact ? article : <PixelPanel accent={focus ? "#ec4899" : promoted ? "#fbbf24" : "rgba(34,211,238,0.2)"}>{article}</PixelPanel>;
}
