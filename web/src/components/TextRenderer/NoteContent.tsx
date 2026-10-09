import { useMemo, useRef, type ReactNode } from "react";
import { noteAttachments, quoteReference } from "../../lib/noteAttachments";
import { parseContent, type ContentToken } from "../../utils/textProcessing/parseContent";
import { videoPoster } from "../../lib/noteMedia";
import { noteTextTokens } from "../../lib/noteTextTokens";
import { firstPreviewLink } from "../../lib/linkPreview";
import { useNoteLinkPlacement } from "../../hooks/useNoteLinkPlacement";
import { InlineNoteText } from "./InlineNoteText";
import { NoteMediaGallery } from "./NoteMediaGallery";
import { NoteLinkPreview } from "./NoteLinkPreview";
import { NoteQuote } from "./NoteQuote";

/** Text unfolds independently of media. Only board cards use the adaptive columns and emphasis. */
export function NoteContent({ text, tags, ownId, adaptive = false, embedQuotes = true, previewLinks = true, initiallyExpanded = false, initiallyExpandedTexts = [], textPresentation }: {
    text: string; tags?: string[][]; ownId?: string; adaptive?: boolean; embedQuotes?: boolean; previewLinks?: boolean;
    initiallyExpanded?: boolean; initiallyExpandedTexts?: readonly string[];
    /** Paid text presentation; media and references still come from the signed note. */
    textPresentation?: ReactNode;
}) {
    // Read-cache snapshots copy tags. Preserve text measurement across updates
    // when the signed content and attachment references have not changed.
    const tagsKey = JSON.stringify(tags ?? []);
    const content = useMemo(() => {
        const tokens = parseContent(text);
        const attachments = noteAttachments(text, JSON.parse(tagsKey) as string[][], ownId);
        const quotes = embedQuotes ? attachments.quotes : [];
        const quoteKeys = new Set(quotes.map(reference => reference.key));
        const words = noteTextTokens(tokens.filter(token => {
            if (token.kind === "image" || token.kind === "video") return false;
            if (token.kind === "link" || token.kind === "mention") return !quoteKeys.has(quoteReference(token.kind === "link" ? token.href : token.bech32)?.key ?? "");
            return true;
        }));
        const length = words.reduce((count, token) => count + (token.kind === "text" ? token.value.length : token.kind === "link" ? Math.min(48, token.href.length) : 16), 0);
        const images = [...new Set(tokens.flatMap(token => token.kind === "image" ? [token.src] : []))];
        const videos = [...new Set(tokens.flatMap(token => token.kind === "video" ? [token.src] : []))];
        const hasVisualMedia = !!(images.length || videos.length);
        const hasLink = previewLinks && !!firstPreviewLink(text);
        return { words: words as ContentToken[], length, images, videos, quotes, hasVisualMedia, hasLink, hasMedia: hasVisualMedia || hasLink || !!quotes.length };
    }, [text, tagsKey, ownId, embedQuotes, previewLinks]);
    const emphasis = adaptive && content.length <= 100 ? "brief" : adaptive && (content.length <= 160 || !content.hasMedia && content.length <= 280) ? "short" : undefined;
    const complete = adaptive && (content.length <= 220 || !content.hasMedia && content.length <= 280);
    const root = useRef<HTMLDivElement>(null);
    useNoteLinkPlacement(root, adaptive && content.hasVisualMedia && content.hasLink, JSON.stringify([text, tags, !!textPresentation]));
    return <div ref={root} className={`note-composition${adaptive ? " note-composition--adaptive" : ""}${content.hasMedia ? "" : " note-composition--text"}${content.hasVisualMedia ? " note-composition--media" : ""}`} data-text-emphasis={emphasis} data-text-complete={complete || !!textPresentation || undefined}>
        {textPresentation ? <div className="note-composition-presentation">{textPresentation}</div> :
            <InlineNoteText tokens={content.words} complete={complete} initiallyExpanded={initiallyExpandedTexts.includes("main") || initiallyExpanded} />}
        {content.hasVisualMedia && <div className="note-composition-media">
            <NoteMediaGallery images={content.images} />
            {content.videos.map(src => <video key={src} className="note-content-video" src={src} poster={videoPoster(tags, src)} controls playsInline preload="metadata" data-note-block />)}
        </div>}
        {content.hasLink && <NoteLinkPreview text={text} />}
        {!!content.quotes.length && <div className="note-composition-quotes">
            {content.quotes.map(reference => <NoteQuote key={reference.key} reference={reference} adaptive
                parentMedia={[...content.images, ...content.videos]} initiallyExpandedTexts={initiallyExpandedTexts} />)}
        </div>}
    </div>;
}
