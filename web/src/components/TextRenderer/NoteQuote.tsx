import { useEffect, useRef, useState } from "react";
import { NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk";
import { readNostr } from "../../lib/nostrReads";
import { newerEvent, nostrCache } from "../../lib/nostrCache";
import { ndk } from "../../lib/ndk";
import { quoteImages, type NoteQuoteReference } from "../../lib/noteAttachments";
import { parseContent } from "../../utils/textProcessing/parseContent";
import { videoPoster } from "../../lib/noteMedia";
import { noteTextTokens } from "../../lib/noteTextTokens";
import { UserProfileInline } from "../UserProfileInline/UserProfileInline";
import { InlineNoteText } from "./InlineNoteText";
import { NoteMediaGallery } from "./NoteMediaGallery";
import { NoteLinkPreview } from "./NoteLinkPreview";
import { QuoteMedia } from "./QuoteMedia";
import { NoteExternalLink } from "../ui/NoteControls";
import { StatusMessage } from "../ui/StatusMessage";

/** One level of quotation only. A quote never imports another ranked row or its animations. */
export function NoteQuote({ reference, adaptive = false, initiallyExpanded = false, initiallyExpandedTexts = [] }: { reference: NoteQuoteReference; adaptive?: boolean; initiallyExpanded?: boolean; initiallyExpandedTexts?: readonly string[] }) {
    // Parents reconstruct references on each board refresh. Request identity must
    // follow the lookup, not the identity of those temporary objects.
    const request = JSON.stringify({
        filter: reference.filter,
        relayUrls: [...new Set(reference.relays)].sort(),
        author: reference.author,
    });
    return <QuotePreview key={request} request={request} href={`https://njump.me/${reference.bech32}`} adaptive={adaptive}
        initiallyExpanded={initiallyExpanded} initiallyExpandedTexts={initiallyExpandedTexts} />;
}

function QuotePreview({ request, href, adaptive, initiallyExpanded, initiallyExpandedTexts }: { request: string; href: string; adaptive: boolean; initiallyExpanded: boolean; initiallyExpandedTexts: readonly string[] }) {
    const container = useRef<HTMLDivElement>(null);
    const [event, setEvent] = useState<NDKEvent | null>(() => {
        const { filter } = JSON.parse(request) as { filter: NDKFilter };
        const cached = nostrCache.query(filter)[0];
        return cached ? new NDKEvent(ndk, cached) : null;
    });
    const [unavailable, setUnavailable] = useState(false);
    const [slow, setSlow] = useState(false);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let started = false;
        const controller = new AbortController();
        let slowTimeout: ReturnType<typeof setTimeout> | undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let stopped = false;
        let found = false;
        const start = () => {
            if (started || stopped) return;
            started = true;
            const { filter, relayUrls, author } = JSON.parse(request) as { filter: NDKFilter; relayUrls: string[]; author?: string };
            void readNostr(filter, relayUrls, author, { signal: controller.signal, timeout: 30000,
                onEvent: (note) => {
                    if (stopped) return;
                    found = true; clearTimeout(slowTimeout);
                    setEvent((current) => !current || newerEvent(note, current.rawEvent() as import("nostr-tools").Event) ? new NDKEvent(ndk, note) : current);
                },
            }).catch(() => {});
            // A slow relay has not proved that a note is missing. Keep this
            // attempt open and distinguish a timeout from an unavailable note.
            slowTimeout = setTimeout(() => { if (!stopped && !found) setSlow(true); }, 8000);
            timeout = setTimeout(() => {
                if (stopped) return;
                stopped = true;
                setUnavailable(!found);
                controller.abort();
            }, 30000);
        };
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) { observer.disconnect(); start(); }
        }, { rootMargin: "200px" });
        if (container.current) observer.observe(container.current);
        return () => { stopped = true; observer.disconnect(); clearTimeout(slowTimeout); clearTimeout(timeout); controller.abort(); };
    }, [request, attempt]);

    return (
        <div ref={container} className={`note-quote${adaptive ? " note-quote--adaptive" : ""}`} aria-label="Quoted note" data-note-block>
            <div className="note-quote-header">
                {event && <UserProfileInline pubkey={event.pubkey} size="compact" />}
                <NoteExternalLink href={href} label="Open quoted note" className="note-quote-open shrink-0" />
            </div>
            {event ? <>
                <QuoteText key={event.id} event={event} initiallyExpanded={initiallyExpanded || initiallyExpandedTexts.includes(`quote:${event.id}`)} textKey={`quote:${event.id}`} />
                {adaptive ? <NoteMediaGallery images={quoteImages(event.content)} quoted /> : <QuoteMedia images={quoteImages(event.content)} />}
                {adaptive && parseContent(event.content).flatMap((token, index) => token.kind === "video" ? [<video key={index}
                    className="note-content-video" src={token.src} poster={videoPoster(event.tags, token.src)} controls playsInline preload="metadata" />] : [])}
                <NoteLinkPreview text={event.content} />
            </> : <div className="mt-2">
                <StatusMessage compact loading={!unavailable}>
                    {unavailable ? "Preview timed out" : slow ? "Still loading preview..." : "Loading preview..."}
                </StatusMessage>
                {unavailable && <button type="button" className="note-action mt-1" onClick={() => {
                    setUnavailable(false); setSlow(false); setAttempt((value) => value + 1);
                }}>Retry preview</button>}
            </div>}
        </div>
    );
}

function QuoteText({ event, initiallyExpanded, textKey }: { event: NDKEvent; initiallyExpanded: boolean; textKey: string }) {
    const tokens = noteTextTokens(parseContent(event.content).filter(token => token.kind !== "image" && token.kind !== "video"));
    const length = tokens.reduce((count, token) => count + (token.kind === "text" ? token.value.length : 32), 0);
    return <InlineNoteText tokens={tokens} className="note-quote__excerpt" complete={length <= 160} quoted
        initiallyExpanded={initiallyExpanded} textKey={textKey} />;
}
