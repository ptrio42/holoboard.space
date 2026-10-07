import type { ReactNode } from "react";
import { ENABLE_PROFILES } from "../../config";
import { njumpUrl } from "../../lib/nostr";
import { profileHref, profileRoute } from "../../lib/readingRoutes";
import { navigateReading } from "../../lib/discussionNavigation";

export function ProfileLink({ pubkey, hints = [], className, title, children }: { pubkey: string; hints?: string[]; className?: string; title?: string; children: ReactNode }) {
    const current = window.location.pathname + window.location.search;
    const local = ENABLE_PROFILES && /^[0-9a-f]{64}$/.test(pubkey);
    return <a href={local ? profileHref(pubkey, profileRoute(current)?.from ?? current, hints) : njumpUrl(pubkey)}
        onClick={local ? navigateReading : undefined} target={local ? undefined : "_blank"}
        rel="noopener noreferrer nofollow" className={className} title={title}>{children}</a>;
}
