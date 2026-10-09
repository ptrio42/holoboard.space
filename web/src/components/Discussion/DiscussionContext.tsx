import type { Event } from "nostr-tools";
import type { ThreadNode } from "../../lib/threadGraph";
import { shortNpub } from "../../lib/nostr";
import { useProfileValue } from "../../hooks/useProfile";
import { discussionHref } from "../../lib/discussionView";
import { navigateReading } from "../../lib/discussionNavigation";
import { parseContent } from "../../utils/textProcessing/parseContent";
import { linkLabel } from "../../lib/noteAttachments";

export interface DiscussionContextProps {
    node?: ThreadNode; parent?: ThreadNode; parentEvent?: Event; onParent?: () => void;
    parentHints?: string[]; compact?: boolean; parentIsFocus?: boolean;
}

export function DiscussionContext({ node, parent, parentEvent, onParent, parentHints = [], compact = false, parentIsFocus = false }: DiscussionContextProps) {
    const parentProfile = useProfileValue(parent?.event?.pubkey, parentHints);
    const parentName = parent?.event && (parentProfile?.displayName?.trim() || parentProfile?.name?.trim() || shortNpub(parent.event.pubkey));
    const parentPreview = (!compact || !parentIsFocus) && parentEvent && parseContent(parentEvent.content).map(token =>
        token.kind === "text" ? token.value : token.kind === "mention" ? `${token.bech32.slice(0, 12)}...` :
            token.kind === "link" ? linkLabel(token.href) : token.kind === "image" ? "[Image]" : "[Video]"
    ).join("").replace(/\s+/g, " ").trim().slice(0, 160);
    const messages: string[] = [];
    if (node && !["none", "resolved"].includes(node.parentState)) {
        messages.push(node.parentState === "missing" ? "Parent not found yet. This branch keeps its original reference."
            : node.parentState === "external" ? "Replies refer to an external context." : "The parent relationship could not be resolved safely.");
    }
    if (node && ["invalid", "conflict", "unresolved", "budget", "depth-limit"].includes(node.rootState)) messages.push("Root context remains unresolved.");
    return <div className="discussion-context">
            {parent?.event && <a href={discussionHref(parent.event.id, parent.event.pubkey, window.location.pathname + window.location.search, parentHints)}
                onClick={event => { if (!onParent) return navigateReading(event); if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onParent(); }}
                className="discussion-parent focus-pixel"
                aria-label={`Go to parent note by ${parentName}`}>
                <span className="flex min-w-0 items-center gap-2"><svg aria-hidden="true" className="shrink-0 text-cyan-400/60" width="10" height="10" viewBox="0 0 10 10" fill="currentColor" shapeRendering="crispEdges"><path d="M0 0h2v4h4V2h2v2h2v2H8v2H6V6H0V0Z" /></svg>
                    <span className="truncate">Replying to <span className="text-cyan-200">{parentName}</span></span>
                </span>
                {parentPreview && <span data-parent-preview className="mt-0.5 line-clamp-1 break-all pl-[18px] text-cyan-100/55">{parentPreview}</span>}
            </a>}
            {messages.length > 0 && <details className="discussion-context-status">
                <summary className="focus-pixel">Unresolved context</summary>
                <div>{messages.map(message => <p key={message}>{message}</p>)}</div>
            </details>}
    </div>;
}
