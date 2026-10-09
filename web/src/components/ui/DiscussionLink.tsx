import type { ReactNode } from "react";
import { CommentIcon } from "./NoteControls";
import { discussionHref, discussionRoute } from "../../lib/discussionView";
import { nostrCache } from "../../lib/nostrCache";
import { verifiedNostrEvent } from "../../lib/verifyNostrEvent";
import { navigateReading } from "../../lib/discussionNavigation";
import { profileRoute } from "../../lib/readingRoutes";
import type { BoardNotePresentation } from "../../lib/readingPosition";

export function DiscussionLink({ id, author, hints = [], label = "Discussion", accessibleLabel, compact = false, seed, presentation, children }: { id: string; author?: string; hints?: string[]; label?: string; accessibleLabel?: string; compact?: boolean; seed?: unknown; presentation?: BoardNotePresentation; children?: ReactNode }) {
    const current = window.location.pathname + window.location.search;
    const from = profileRoute(current) ? current : discussionRoute(current)?.from ?? current;
    return <a className={children ? "discussion-time inline-flex min-h-11 min-w-11 items-center justify-end" : compact ? "note-icon-control board-discussion" : "note-action inline-flex min-h-11 items-center gap-2"} aria-label={accessibleLabel ?? label} title={accessibleLabel ?? label} href={discussionHref(id, author, from, hints)} onClick={event => {
        if (discussionRoute(current)?.focusId === id && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
            const replies = document.getElementById("discussion-replies");
            if (replies) { event.preventDefault(); replies.scrollIntoView({ block: "start" }); replies.focus({ preventScroll: true }); return; }
        }
        const verified = verifiedNostrEvent(seed); if (verified?.id === id) nostrCache.put(verified); navigateReading(event, verified?.id === id ? presentation : undefined);
    }}>
        {children ?? <><CommentIcon />{!compact && label}</>}
    </a>;
}
