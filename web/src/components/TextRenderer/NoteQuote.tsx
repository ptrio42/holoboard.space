import { useEffect, useRef, useState } from "react";
import { NDKSubscriptionCacheUsage, type NDKEvent, type NDKFilter, type NDKSubscription } from "@nostr-dev-kit/ndk";
import { PUBLIC_RELAYS, RELAY_URL } from "../../config";
import { ndk } from "../../lib/ndk";
import { quoteImages, quotePreviewContent, type NoteQuoteReference } from "../../lib/noteAttachments";
import { UserProfileInline } from "../UserProfileInline/UserProfileInline";
import { CompactNoteText } from "./CompactNoteText";
import { NoteLinkPreview } from "./NoteLinkPreview";
import { QuoteMedia } from "./QuoteMedia";
import { NoteExternalLink } from "../ui/NoteControls";

/** One level of quotation only. A quote never imports another ranked row or its animations. */
export function NoteQuote({ reference }: { reference: NoteQuoteReference }) {
    // Parents reconstruct references on each board refresh. Request identity must
    // follow the lookup, not the identity of those temporary objects.
    const request = JSON.stringify({
        filter: reference.filter,
        relayUrls: [...new Set([RELAY_URL, ...PUBLIC_RELAYS, ...reference.relays.filter((url) => /^wss?:\/\//i.test(url))])].sort(),
    });
    return <QuotePreview key={request} request={request} href={`https://njump.me/${reference.bech32}`} />;
}

function QuotePreview({ request, href }: { request: string; href: string }) {
    const container = useRef<HTMLDivElement>(null);
    const [event, setEvent] = useState<NDKEvent | null>(null);
    const [unavailable, setUnavailable] = useState(false);
    const [slow, setSlow] = useState(false);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let subscription: NDKSubscription | undefined;
        let slowTimeout: ReturnType<typeof setTimeout> | undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let stopped = false;
        let found = false;
        const start = () => {
            if (subscription || stopped) return;
            const { filter, relayUrls } = JSON.parse(request) as { filter: NDKFilter; relayUrls: string[] };
            subscription = ndk.subscribe(filter, {
                // NDK can emit EOSE after only the faster relays have responded.
                // Keep slower sources open until the lookup deadline.
                closeOnEose: false,
                cacheUsage: NDKSubscriptionCacheUsage.PARALLEL,
                // Grouped requests can outlive a row changing from plain text to billboard.
                groupable: false,
                relayUrls,
            }, false);
            subscription.on("event", (note: NDKEvent) => {
                if (stopped) return;
                found = true;
                clearTimeout(slowTimeout);
                setEvent((current) => !current || (note.created_at ?? 0) > (current.created_at ?? 0) ? note : current);
            });
            // A slow relay has not proved that a note is missing. Keep this
            // attempt open and distinguish a timeout from an unavailable note.
            slowTimeout = setTimeout(() => { if (!stopped && !found) setSlow(true); }, 8000);
            timeout = setTimeout(() => {
                if (stopped) return;
                stopped = true;
                setUnavailable(!found);
                subscription?.stop();
            }, 30000);
            subscription.start();
        };
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) { observer.disconnect(); start(); }
        }, { rootMargin: "200px" });
        if (container.current) observer.observe(container.current);
        return () => { stopped = true; observer.disconnect(); clearTimeout(slowTimeout); clearTimeout(timeout); subscription?.stop(); };
    }, [request, attempt]);

    return (
        <div ref={container} className="note-quote" aria-label="Quoted note" data-note-block>
            <div className="flex items-center justify-between gap-2">
                <span className="font-pixel text-[8px] tracking-widest text-cyan-300/50">QUOTED NOTE</span>
                <NoteExternalLink href={href} label="Open quoted note" className="-my-2 shrink-0" />
            </div>
            {event ? <>
                <div className="mt-2"><UserProfileInline pubkey={event.pubkey} /></div>
                <div className="note-quote__excerpt mt-2 text-[13px] leading-relaxed text-cyan-50/80">
                    <CompactNoteText text={quotePreviewContent(event.content)} />
                </div>
                <QuoteMedia images={quoteImages(event.content)} />
                <NoteLinkPreview text={event.content} />
            </> : <div className="mt-2">
                <p role="status" className="text-xs text-cyan-100/50">{unavailable ? "Preview timed out" : slow ? "Still loading preview…" : "Loading preview…"}</p>
                {unavailable && <button type="button" className="note-action mt-1" onClick={() => {
                    setUnavailable(false); setSlow(false); setAttempt((value) => value + 1);
                }}>Retry preview</button>}
            </div>}
        </div>
    );
}
