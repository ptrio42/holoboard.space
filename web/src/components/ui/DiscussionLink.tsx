import { discussionHref, discussionRoute } from "../../lib/discussionView";
import { nostrCache } from "../../lib/nostrCache";
import { verifiedNostrEvent } from "../../lib/verifyNostrEvent";
import { navigateReading } from "../../lib/discussionNavigation";
import { profileRoute } from "../../lib/readingRoutes";
import type { BoardNotePresentation } from "../../lib/readingPosition";

export function DiscussionLink({ id, author, hints = [], label = "Discussion", accessibleLabel, compact = false, seed, presentation }: { id: string; author?: string; hints?: string[]; label?: string; accessibleLabel?: string; compact?: boolean; seed?: unknown; presentation?: BoardNotePresentation }) {
    const current = window.location.pathname + window.location.search;
    const from = profileRoute(current) ? current : discussionRoute(current)?.from ?? current;
    return <a className={compact ? "note-icon-control board-discussion" : "note-action inline-flex min-h-11 items-center gap-2"} aria-label={accessibleLabel ?? label} title={accessibleLabel ?? label} href={discussionHref(id, author, from, hints)} onClick={event => {
        if (discussionRoute(current)?.focusId === id && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
            const replies = document.getElementById("discussion-replies");
            if (replies) { event.preventDefault(); replies.scrollIntoView({ block: "start" }); replies.focus({ preventScroll: true }); return; }
        }
        const verified = verifiedNostrEvent(seed); if (verified?.id === id) nostrCache.put(verified); navigateReading(event, verified?.id === id ? presentation : undefined);
    }}>
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="currentColor" shapeRendering="crispEdges"><path d="M0 0h12v8H6v2H4v2H2V8H0V0Zm2 2v4h2v2h2V6h4V2H2Z" /></svg>
        {!compact && label}
    </a>;
}
