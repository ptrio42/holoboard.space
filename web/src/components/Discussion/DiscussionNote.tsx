import type { Event } from "nostr-tools";
import type { ThreadNode } from "../../lib/threadGraph";
import { njumpUrl } from "../../lib/nostr";
import TextRenderer from "../TextRenderer/TextRenderer";
import { UserProfileInline } from "../UserProfileInline/UserProfileInline";
import { Expandable } from "../ui/Expandable";
import { NoteExternalLink } from "../ui/NoteControls";
import { DiscussionLink } from "../ui/DiscussionLink";
import { PixelPanel } from "../ui/PixelPanel";

export function DiscussionNote({ node, event, focus = false, promoted = false, children }: {
    node?: ThreadNode; event?: Event; focus?: boolean; promoted?: boolean; children?: React.ReactNode;
}) {
    const date = node?.event && new Date(node.event.created_at * 1000);
    const validDate = date && Number.isFinite(date.getTime());
    return <PixelPanel accent={focus ? "#ec4899" : promoted ? "#fbbf24" : "rgba(34,211,238,0.35)"}>
        <article className="space-y-3 p-4" aria-label={focus ? "Discussion focus" : undefined}>
            <header className="flex flex-wrap items-center justify-between gap-2">
                {node?.event ? <UserProfileInline pubkey={node.event.pubkey} /> : <span className="font-pixel text-[10px] text-cyan-100">Missing context</span>}
                <div className="flex flex-wrap items-center gap-3 text-xs text-cyan-200/75">
                    {focus && <span className="font-pixel text-[10px] text-neon-pink">Focus</span>}
                    {promoted && <span className="font-pixel text-[10px] text-neon-gold">Promoted</span>}
                    {validDate && <time dateTime={date.toISOString()}>{date.toLocaleDateString()}</time>}
                </div>
            </header>
            {node && !["none", "resolved"].includes(node.parentState) && <p className="text-xs text-cyan-100/75">
                {node.parentState === "missing" ? "Parent not found yet. This branch keeps its original reference." : node.parentState === "external" ? "Replies refer to an external context." : "The parent relationship could not be resolved safely."}
            </p>}
            {node && ["invalid", "conflict", "unresolved", "budget", "depth-limit"].includes(node.rootState) && <p className="text-xs text-cyan-100/75">Root context remains unresolved.</p>}
            {event ? <Expandable label={focus ? "focused note" : "reply"} footer={control => <div className="note-footer flex-wrap">
                {control}<div className="ml-auto flex flex-wrap items-center justify-end gap-x-4">
                    {!focus && <DiscussionLink id={event.id} author={event.pubkey} seed={event} label="Focus here" />}
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
