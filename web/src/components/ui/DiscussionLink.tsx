import { discussionHref, discussionRoute } from "../../lib/discussionView";
import { nostrCache } from "../../lib/nostrCache";
import { verifiedNostrEvent } from "../../lib/verifyNostrEvent";
import { navigateReading } from "../../lib/discussionNavigation";
import { profileRoute } from "../../lib/readingRoutes";

export function DiscussionLink({ id, author, label = "Discussion", accessibleLabel, seed }: { id: string; author?: string; label?: string; accessibleLabel?: string; seed?: unknown }) {
    const current = window.location.pathname + window.location.search;
    const from = profileRoute(current) ? current : discussionRoute(current)?.from ?? current;
    return <a className="note-action inline-flex min-h-11 items-center gap-2" aria-label={accessibleLabel} title={accessibleLabel} href={discussionHref(id, author, from)} onClick={event => { const verified = verifiedNostrEvent(seed); if (verified?.id === id) nostrCache.put(verified); navigateReading(event); }}>
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="currentColor" shapeRendering="crispEdges"><path d="M0 0h12v8H6v2H4v2H2V8H0V0Zm2 2v4h2v2h2V6h4V2H2Z" /></svg>
        {label}
    </a>;
}
