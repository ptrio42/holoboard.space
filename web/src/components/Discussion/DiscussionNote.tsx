import type { Event } from "nostr-tools";
import type { ThreadNode } from "../../lib/threadGraph";
import { njumpUrl, shortNpub } from "../../lib/nostr";
import TextRenderer from "../TextRenderer/TextRenderer";
import { UserProfileInline } from "../UserProfileInline/UserProfileInline";
import { Expandable } from "../ui/Expandable";
import { NoteExternalLink } from "../ui/NoteControls";
import { DiscussionLink } from "../ui/DiscussionLink";
import { PixelPanel } from "../ui/PixelPanel";
import { useProfileValue } from "../../hooks/useProfile";
import { discussionHref } from "../../lib/discussionView";
import { navigateReading } from "../../lib/discussionNavigation";

export function DiscussionNote({ node, event, parent, parentEvent, onParent, focus = false, promoted = false, children }: {
    node?: ThreadNode; event?: Event; parent?: ThreadNode; parentEvent?: Event; onParent?: () => void;
    focus?: boolean; promoted?: boolean; children?: React.ReactNode;
}) {
    const parentProfile = useProfileValue(parent?.event?.pubkey);
    const parentName = parent?.event && (parentProfile?.displayName?.trim() || parentProfile?.name?.trim() || shortNpub(parent.event.pubkey));
    const parentPreview = parentEvent?.content.replace(/\s+/g, " ").trim().slice(0, 160);
    const date = node?.event && new Date(node.event.created_at * 1000);
    const validDate = date && Number.isFinite(date.getTime());
    return <PixelPanel accent={focus ? "#ec4899" : promoted ? "#fbbf24" : "rgba(34,211,238,0.2)"}>
        <article className="space-y-3 p-3 sm:p-4" aria-label={focus ? "Discussion focus" : undefined}>
            <header className="flex flex-wrap items-center justify-between gap-2">
                {node?.event ? <UserProfileInline pubkey={node.event.pubkey} /> : <span className="font-pixel text-[10px] text-cyan-100">Missing context</span>}
                <div className="flex flex-wrap items-center gap-3 text-xs text-cyan-200/75">
                    {promoted && <span className="font-pixel text-[10px] text-neon-gold">Promoted</span>}
                    {validDate && <time dateTime={date.toISOString()} title={date.toLocaleString()}>{date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}
                </div>
            </header>
            {parent?.event && <a href={discussionHref(parent.event.id, parent.event.pubkey, window.location.pathname + window.location.search)}
                onClick={event => { if (!onParent) return navigateReading(event); if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onParent(); }}
                className="focus-pixel flex min-h-11 min-w-0 flex-col justify-center border-l-2 border-cyan-400/40 pl-3 text-xs text-cyan-100/75 no-underline hover:border-neon-cyan hover:text-cyan-100"
                aria-label={`Go to parent note by ${parentName}`}>
                <span>Replying to <span className="text-neon-cyan">{parentName}</span></span>
                {parentPreview && <span className="line-clamp-1 break-all">{parentPreview}</span>}
            </a>}
            {node && !["none", "resolved"].includes(node.parentState) && <p className="text-xs text-cyan-100/75">
                {node.parentState === "missing" ? "Parent not found yet. This branch keeps its original reference." : node.parentState === "external" ? "Replies refer to an external context." : "The parent relationship could not be resolved safely."}
            </p>}
            {node && ["invalid", "conflict", "unresolved", "budget", "depth-limit"].includes(node.rootState) && <p className="text-xs text-cyan-100/75">Root context remains unresolved.</p>}
            {event ? <Expandable label={focus ? "focused note" : "reply"} footer={control => <div className="note-footer flex-wrap">
                {control}<div className="ml-auto flex flex-wrap items-center justify-end gap-x-4">
                    {!focus && <DiscussionLink id={event.id} author={event.pubkey} seed={event} label="Open thread" />}
                    <NoteExternalLink href={njumpUrl(event.id, "note")} />{children}
                </div>
            </div>}><TextRenderer text={event.content} tags={event.tags} ownId={event.id} embedQuotes={false} previewLinks={false} /></Expandable> : <>
                <p className="break-words text-sm text-cyan-100/75">{node?.event ? "Content is unavailable in the read cache." : "This referenced note has not been found. Other replies remain available."}</p>
                {node?.reference.type === "event" && <div className="note-footer"><NoteExternalLink href={njumpUrl(node.reference.value, "note")} />{children}</div>}
                {node?.reference.type !== "event" && children}
            </>}
        </article>
    </PixelPanel>;
}
