import { useMemo, useRef, type ReactNode } from "react";
import { noteAttachments, quoteReference } from "../../lib/noteAttachments";
import { type ContentToken } from "../../utils/textProcessing/parseContent";
import { mediaTokens, noteMediaItems } from "../../lib/noteMedia";
import { noteTextTokens } from "../../lib/noteTextTokens";
import { firstPreviewLink } from "../../lib/linkPreview";
import { useNoteLinkPlacement } from "../../hooks/useNoteLinkPlacement";
import { InlineNoteText } from "./InlineNoteText";
import { NoteMediaGallery } from "./NoteMediaGallery";
import { NoteLinkPreview } from "./NoteLinkPreview";
import { NoteQuote } from "./NoteQuote";

/** Text unfolds independently of media. Only board cards use the adaptive columns and emphasis. */
export function NoteContent({ text, tags, ownId, adaptive = false, embedQuotes = true, quoteLimit, strictReferences = false, previewLinks = true, initiallyExpanded = false, initiallyExpandedTexts = [], textPresentation }: {
    text: string; tags?: string[][]; ownId?: string; adaptive?: boolean; embedQuotes?: boolean; quoteLimit?: number; strictReferences?: boolean; previewLinks?: boolean;
    initiallyExpanded?: boolean; initiallyExpandedTexts?: readonly string[];
    /** Paid text presentation; media and references still come from the signed note. */
    textPresentation?: ReactNode;
}) {
    // Read-cache snapshots copy tags. Preserve text measurement across updates
    // when the signed content and attachment references have not changed.
    const tagsKey = JSON.stringify(tags ?? []);
    const content = useMemo(() => {
        const tokens = mediaTokens(text, JSON.parse(tagsKey));
        const attachments = noteAttachments(text, JSON.parse(tagsKey) as string[][], ownId, strictReferences);
        const quotes = embedQuotes ? attachments.quotes.slice(0, quoteLimit) : [];
        const quoteKeys = new Set(quotes.map(reference => reference.key));
        const words = noteTextTokens(tokens.filter(token => {
            if (token.kind === "image" || token.kind === "video") return false;
            if (token.kind === "link" || token.kind === "mention") return !quoteKeys.has(quoteReference(token.kind === "link" ? token.href : token.bech32)?.key ?? "");
            return true;
        }));
        const length = words.reduce((count, token) => count + (token.kind === "text" ? token.value.length : token.kind === "link" ? Math.min(48, token.href.length) : 16), 0);
        const media = noteMediaItems(tokens, JSON.parse(tagsKey));
        const hasVisualMedia = !!media.length;
        const link = previewLinks ? firstPreviewLink(tokens.flatMap(token => token.kind === "link" ? [token.href] : []).join("\n"), strictReferences) : null;
        const hasLink = !!link;
        return { words: words as ContentToken[], length, media, quotes, link, hasVisualMedia, hasLink, hasMedia: hasVisualMedia || hasLink || !!quotes.length };
    }, [text, tagsKey, ownId, embedQuotes, quoteLimit, strictReferences, previewLinks]);
    const emphasis = adaptive && content.length <= 100 ? "brief" : adaptive && (content.length <= 160 || !content.hasMedia && content.length <= 280) ? "short" : undefined;
    const complete = adaptive && (content.length <= 220 || !content.hasMedia && content.length <= 280);
    const root = useRef<HTMLDivElement>(null);
    useNoteLinkPlacement(root, adaptive && content.hasVisualMedia && content.hasLink, JSON.stringify([text, tags, !!textPresentation]));
    return <div ref={root} className={`note-composition${adaptive ? " note-composition--adaptive" : ""}${content.hasMedia ? "" : " note-composition--text"}${content.hasVisualMedia ? " note-composition--media" : ""}`} data-text-emphasis={emphasis} data-text-complete={complete || !!textPresentation || undefined}>
        {textPresentation ? <div className="note-composition-presentation">{textPresentation}</div> :
            <InlineNoteText tokens={content.words} complete={complete} initiallyExpanded={initiallyExpandedTexts.includes("main") || initiallyExpanded} />}
        {content.hasVisualMedia && <div className="note-composition-media">
            <NoteMediaGallery items={content.media} galleryKey={ownId} />
        </div>}
        {content.hasLink && <NoteLinkPreview text={text} url={content.link} />}
        {!!content.quotes.length && <div className="note-composition-quotes">
            {content.quotes.map(reference => <NoteQuote key={reference.key} reference={reference} adaptive
                parentMedia={content.media.map(item => item.src)} initiallyExpandedTexts={initiallyExpandedTexts} />)}
        </div>}
    </div>;
}
