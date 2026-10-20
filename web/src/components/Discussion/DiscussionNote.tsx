import { DiscussionContext } from "./DiscussionContext";
import type { Event } from "nostr-tools";
import type { ThreadNode } from "../../lib/threadGraph";
import { njumpUrl } from "../../lib/nostr";
import { NoteContent } from "../TextRenderer/NoteContent";
import { NoteAuthor } from "../UserProfileInline/NoteAuthor";
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
    const branchControl = branch && <button type="button" className="note-action discussion-branch"
        aria-label={branch.expanded ? "Hide replies" : `Show replies (${branch.count})`} title={branch.expanded ? "Hide replies" : `Show replies (${branch.count})`}
        aria-expanded={branch.expanded} onClick={branch.toggle}>
        <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="currentColor" shapeRendering="crispEdges">
            <path d={branch.expanded ? "M0 2h2v2h2v2h2V4h2V2h2v4H8v2H6v2H4V8H2V6H0z" : "M2 0h4v2h2v2h2v2H8v2H6v2H2V8h2V6h2V4H4V2H2z"} />
        </svg><span aria-hidden="true">{branch.count}</span>
    </button>;
    const context = <DiscussionContext node={node} parent={parent} parentEvent={parentEvent} parentHints={parentHints} onParent={onParent} compact={compact} parentIsFocus={parentIsFocus} />;
    const footer = () => <footer className="discussion-actions">
        {onReply && <NoteReplyButton onClick={onReply} />}
        {node?.reference.type === "event" && <NoteExternalLink href={njumpUrl(node.reference.value, "note", hints, event?.pubkey)} />}
        {compact && promoted && <span className="discussion-promotion">Promoted</span>}
        {branchControl}
        {validDate && (event && !focus
            ? <DiscussionLink id={event.id} author={event.pubkey} hints={hints} seed={event} accessibleLabel="Open thread">
                <time dateTime={date.toISOString()} title={`${date.toLocaleString()} (open thread)`}>{date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time>
            </DiscussionLink>
            : <time className="discussion-time" dateTime={date.toISOString()} title={date.toLocaleString()}>{date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time>)}
    </footer>;
    const article = <article className={`discussion-note ${compact ? "discussion-note-compact" : "p-3 sm:p-5"} ${promoted ? "discussion-note-promoted" : ""}`} aria-label={focus ? "Discussion focus" : undefined}>
        <header className={`discussion-note__header${compact && parent?.event ? " has-parent" : ""}`}>
            {node?.event ? <NoteAuthor event={node.event} hints={hints} size="compact" /> : <span className="font-pixel text-[10px] text-cyan-100">Missing context</span>}
            {compact ? context : promoted && <span className="discussion-promotion">Promoted</span>}
        </header>
        <div className="discussion-note__content">
            {!compact && context}
            {event ? <><NoteContent text={event.content} tags={event.tags} ownId={event.id} embedQuotes={false} previewLinks={false} />{footer()}</> : <>
                <p className="my-2 break-words text-sm text-cyan-100/75">{node?.event ? "Content is unavailable in the read cache." : "This referenced note has not been found. Other replies remain available."}</p>
                {footer()}
            </>}
        </div>
    </article>;
    return compact ? article : <PixelPanel accent={focus ? "#ec4899" : promoted ? "#fbbf24" : "rgba(34,211,238,0.2)"}>{article}</PixelPanel>;
}
