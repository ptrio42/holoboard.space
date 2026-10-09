import { DiscussionContext } from "./DiscussionContext";
import type { Event } from "nostr-tools";
import type { ThreadNode } from "../../lib/threadGraph";
import { njumpUrl } from "../../lib/nostr";
import { NoteContent } from "../TextRenderer/NoteContent";
import { UserProfileInline } from "../UserProfileInline/UserProfileInline";
import { NoteExternalLink, NoteReplyButton } from "../ui/NoteControls";
import { DiscussionLink } from "../ui/DiscussionLink";
import { PixelPanel } from "../ui/PixelPanel";

export function DiscussionNote({ node, event, parent, parentEvent, hints = [], parentHints = [], onParent, focus = false, promoted = false, compact = false, parentIsFocus = false, onReply, branch }: {
    node?: ThreadNode; event?: Event; parent?: ThreadNode; parentEvent?: Event; onParent?: () => void;
    hints?: string[]; parentHints?: string[];
    focus?: boolean; promoted?: boolean; compact?: boolean; parentIsFocus?: boolean; onReply?: () => void;
    branch?: { count: number; expanded: boolean; toggle: () => void };
}) {
    const date = node?.event && new Date(node.event.created_at * 1000);
    const validDate = date && Number.isFinite(date.getTime());
    const footer = (control?: React.ReactNode) => <footer className="discussion-actions">
        {control}
        {onReply && <NoteReplyButton onClick={onReply} />}
        {node?.reference.type === "event" && <NoteExternalLink href={njumpUrl(node.reference.value, "note", hints, event?.pubkey)} />}
        {validDate && (event && !focus
            ? <DiscussionLink id={event.id} author={event.pubkey} hints={hints} seed={event} accessibleLabel="Open thread">
                <time dateTime={date.toISOString()} title={`${date.toLocaleString()} (open thread)`}>{date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time>
            </DiscussionLink>
            : <time className="discussion-time" dateTime={date.toISOString()} title={date.toLocaleString()}>{date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time>)}
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
            <DiscussionContext node={node} parent={parent} parentEvent={parentEvent} parentHints={parentHints} onParent={onParent} compact={compact} parentIsFocus={parentIsFocus} />
            {event ? <><NoteContent text={event.content} tags={event.tags} ownId={event.id} embedQuotes={false} previewLinks={false} />{footer()}</> : <>
                <p className="my-2 break-words text-sm text-cyan-100/75">{node?.event ? "Content is unavailable in the read cache." : "This referenced note has not been found. Other replies remain available."}</p>
                {footer()}
            </>}
        </div>
    </article>;
    return compact ? article : <PixelPanel accent={focus ? "#ec4899" : promoted ? "#fbbf24" : "rgba(34,211,238,0.2)"}>{article}</PixelPanel>;
}
