import { useMemo, type ReactNode } from "react";
import { noteAttachments, quoteReference } from "../../lib/noteAttachments";
import { parseContent, type ContentToken } from "../../utils/textProcessing/parseContent";
import { videoPoster } from "../../lib/noteMedia";
import { noteTextTokens } from "../../lib/noteTextTokens";
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
    const content = useMemo(() => {
        const tokens = parseContent(text);
        const attachments = noteAttachments(text, tags, ownId);
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
        const hasMedia = !!(images.length || videos.length || quotes.length || previewLinks && attachments.links.length);
        return { words: words as ContentToken[], length, images, videos, quotes, hasMedia };
    }, [text, tags, ownId, embedQuotes, previewLinks]);
    const emphasis = adaptive && content.length <= 100 ? "brief" : adaptive && (content.length <= 160 || !content.hasMedia && content.length <= 280) ? "short" : undefined;
    const complete = adaptive && (content.length <= 220 || !content.hasMedia && content.length <= 280);
    return <div className={`note-composition${adaptive ? " note-composition--adaptive" : ""}${content.hasMedia ? "" : " note-composition--text"}`} data-text-emphasis={emphasis}>
        {textPresentation ? <div className="note-composition-presentation">{textPresentation}</div> :
            <InlineNoteText tokens={content.words} complete={complete} initiallyExpanded={initiallyExpandedTexts.includes("main") || initiallyExpanded} />}
        {content.hasMedia && <div className="note-composition-media">
            <NoteMediaGallery images={content.images} />
            {content.videos.map(src => <video key={src} className="note-content-video" src={src} poster={videoPoster(tags, src)} controls playsInline preload="metadata" data-note-block />)}
            {content.quotes.map(reference => <NoteQuote key={reference.key} reference={reference} adaptive
                initiallyExpandedTexts={initiallyExpandedTexts} />)}
            {previewLinks && <NoteLinkPreview text={text} />}
        </div>}
    </div>;
}
