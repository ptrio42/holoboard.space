import { useMemo, useRef, type ReactNode } from "react";
import { noteAttachments, quoteReference } from "../../core/content/noteAttachments";
import { type ContentToken } from "../../core/content/parseContent";
import { mediaTokens, noteMediaItems } from "../../core/content/noteMedia";
import { noteTextTokens } from "../../core/content/noteTextTokens";
import { firstPreviewLink } from "../../core/content/previewLink";
import { useNoteLinkPlacement } from "./useNoteLinkPlacement";
import { InlineNoteText } from "./InlineNoteText";
import { MediaSourceLinks } from "./MediaSourceLinks";
import type { NoteMediaItem } from "../../core/content/noteMedia";
import { NoteMediaGallery } from "./NoteMediaGallery";
import { NoteLinkPreview } from "../capabilities";
import { NoteQuote } from "../capabilities";

/** Text unfolds independently of media. Only board cards use the adaptive columns and emphasis. */
export function NoteContent({ text, tags, ownId, adaptive = false, embedQuotes = true, quoteLimit, strictReferences = false, previewLinks = true, initiallyExpanded = false, initiallyExpandedTexts = [], textPresentation, attachmentsOnly = false }: {
    text: string; tags?: string[][]; ownId?: string; adaptive?: boolean; embedQuotes?: boolean; quoteLimit?: number; strictReferences?: boolean; previewLinks?: boolean;
    initiallyExpanded?: boolean; initiallyExpandedTexts?: readonly string[];
    /** Paid text presentation; media and references still come from the signed note. */
    textPresentation?: ReactNode;
    /** Show attachment context beside an editor without repeating its text. */
    attachmentsOnly?: boolean;
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
        const seenMedia = new Set(media.map(item => item.src));
        const tagOnlyMedia: NoteMediaItem[] = (JSON.parse(tagsKey) as string[][]).flatMap(tag => {
            if (tag[0] !== "imeta") return [];
            const src = tag.find(value => value.startsWith("url "))?.slice(4);
            const mime = tag.find(value => value.startsWith("m "))?.slice(2);
            if (!src || seenMedia.has(src) || !mime || !/^(image|video)\//.test(mime)) return [];
            seenMedia.add(src);
            return [{ kind: mime.startsWith("image/") ? "image" as const : "video" as const, src }];
        });
        const hasVisualMedia = !!media.length;
        const link = previewLinks ? firstPreviewLink(tokens.flatMap(token => token.kind === "link" ? [token.href] : []).join("\n"), strictReferences) : null;
        const hasLink = !!link;
        return { words: words as ContentToken[], length, media, tagOnlyMedia, quotes, link, hasVisualMedia, hasLink, hasMedia: hasVisualMedia || hasLink || !!quotes.length };
    }, [text, tagsKey, ownId, embedQuotes, quoteLimit, strictReferences, previewLinks]);
    const emphasis = adaptive && content.length <= 100 ? "brief" : adaptive && (content.length <= 160 || !content.hasMedia && content.length <= 280) ? "short" : undefined;
    const complete = adaptive && (content.length <= 220 || !content.hasMedia && content.length <= 280);
    const root = useRef<HTMLDivElement>(null);
    useNoteLinkPlacement(root, adaptive && content.hasVisualMedia && content.hasLink, JSON.stringify([text, tags, !!textPresentation]));
    return <div ref={root} className={`note-composition${adaptive ? " note-composition--adaptive" : ""}${content.hasMedia ? "" : " note-composition--text"}${content.hasVisualMedia ? " note-composition--media" : ""}`} data-long-text={content.length > 280 || undefined} data-text-emphasis={emphasis} data-text-complete={complete || !!textPresentation || undefined}>
        {!attachmentsOnly && (textPresentation ? <div className="note-composition-presentation">{textPresentation}</div> :
            <InlineNoteText tokens={content.words} complete={complete} initiallyExpanded={initiallyExpandedTexts.includes("main") || initiallyExpanded} />)}
        {content.hasVisualMedia && <div className="note-composition-media">
            <NoteMediaGallery items={content.media} galleryKey={ownId} />
        </div>}
        <MediaSourceLinks items={content.tagOnlyMedia} />
        {content.hasLink && <NoteLinkPreview text={text} url={content.link} />}
        {!!content.quotes.length && <div className="note-composition-quotes">
            {content.quotes.map(reference => <NoteQuote key={reference.key} reference={reference} adaptive
                parentMedia={content.media.map(item => item.src)} initiallyExpandedTexts={initiallyExpandedTexts} />)}
        </div>}
    </div>;
}

export type NoteContentProps = Parameters<typeof NoteContent>[0];
