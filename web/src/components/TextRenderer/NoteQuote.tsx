import { useEffect, useMemo, useRef, useState } from "react";
import { NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk";
import { readNostr } from "../../lib/nostrReads";
import { newerEvent, nostrCache } from "../../lib/nostrCache";
import { ndk } from "../../lib/ndk";
import { type NoteQuoteReference } from "../../lib/noteAttachments";
import { parseContent } from "../../utils/textProcessing/parseContent";
import { videoPoster } from "../../lib/noteMedia";
import { noteTextTokens } from "../../lib/noteTextTokens";
import { articlePreview } from "../../lib/articlePreview";
import { firstPreviewLink } from "../../lib/linkPreview";
import { useNoteLinkPlacement } from "../../hooks/useNoteLinkPlacement";
import { UserProfileInline } from "../UserProfileInline/UserProfileInline";
import { InlineNoteText } from "./InlineNoteText";
import { NoteMediaGallery } from "./NoteMediaGallery";
import { NoteLinkPreview } from "./NoteLinkPreview";
import { QuoteMedia } from "./QuoteMedia";
import { NoteExternalLink } from "../ui/NoteControls";
import { StatusMessage } from "../ui/StatusMessage";

/** One level of quotation only. A quote never imports another ranked row or its animations. */
export function NoteQuote({ reference, adaptive = false, initiallyExpanded = false, initiallyExpandedTexts = [], parentMedia = [] }: { reference: NoteQuoteReference; adaptive?: boolean; initiallyExpanded?: boolean; initiallyExpandedTexts?: readonly string[]; parentMedia?: readonly string[] }) {
    // Parents reconstruct references on each board refresh. Request identity must
    // follow the lookup, not the identity of those temporary objects.
    const request = JSON.stringify({
        filter: reference.filter,
        relayUrls: [...new Set(reference.relays)].sort(),
        author: reference.author,
    });
    return <QuotePreview key={request} request={request} href={`https://njump.me/${reference.bech32}`} adaptive={adaptive}
        initiallyExpanded={initiallyExpanded} initiallyExpandedTexts={initiallyExpandedTexts} parentMedia={parentMedia} />;
}

function QuotePreview({ request, href, adaptive, initiallyExpanded, initiallyExpandedTexts, parentMedia }: { request: string; href: string; adaptive: boolean; initiallyExpanded: boolean; initiallyExpandedTexts: readonly string[]; parentMedia: readonly string[] }) {
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
            {event ? <QuoteContent key={event.id} event={event} adaptive={adaptive} parentMedia={parentMedia}
                initiallyExpanded={initiallyExpanded || initiallyExpandedTexts.includes(`quote:${event.id}`)} /> : <div className="mt-2">
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

function QuoteContent({ event, adaptive, initiallyExpanded, parentMedia }: { event: NDKEvent; adaptive: boolean; initiallyExpanded: boolean; parentMedia: readonly string[] }) {
    const body = useMemo(() => {
        if (event.kind === 30023) return articlePreview(event.content);
        const tokens = parseContent(event.content);
        return { words: noteTextTokens(tokens.filter(token => token.kind !== "image" && token.kind !== "video")),
            images: [...new Set(tokens.flatMap(token => token.kind === "image" ? [token.src] : []))],
            videos: [...new Set(tokens.flatMap(token => token.kind === "video" ? [token.src] : []))], link: firstPreviewLink(event.content) };
    }, [event.kind, event.content]);
    const images = body.images.filter(src => !parentMedia.includes(src));
    const videos = body.videos.filter(src => !parentMedia.includes(src));
    const visual = !!(images.length || adaptive && videos.length);
    const length = body.words.reduce((count, token) => count + (token.kind === "text" || token.kind === "formatted" ? token.value.length : 32), 0);
    const root = useRef<HTMLDivElement>(null);
    useNoteLinkPlacement(root, adaptive && visual && !!body.link, event.id);
    return <div ref={root} className={`note-quote-layout note-quote-content${adaptive ? " note-composition--adaptive" : ""}${visual ? " note-composition--media" : ""}${visual || body.link ? "" : " note-composition--text"}`}>
        <InlineNoteText tokens={body.words} className="note-quote__excerpt" complete={length <= 160} quoted
            initiallyExpanded={initiallyExpanded} textKey={`quote:${event.id}`} />
        {visual && <div className="note-quote-media">
            {adaptive ? <NoteMediaGallery images={images} quoted /> : <QuoteMedia images={images} />}
            {adaptive && videos.map(src => <video key={src} className="note-content-video" src={src}
                poster={videoPoster(event.tags, src)} controls playsInline preload="metadata" data-note-block />)}
        </div>}
        {body.link && <NoteLinkPreview text={event.content} url={body.link} />}
    </div>;
}
