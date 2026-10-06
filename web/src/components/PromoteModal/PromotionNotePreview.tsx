import { useMemo, useState, type ReactNode } from "react";
import type { NotePreview } from "../../lib/promote";
import { njumpUrl } from "../../lib/nostr";
import { quoteImages, quotePreviewContent } from "../../lib/noteAttachments";
import { UserProfileInline } from "../UserProfileInline/UserProfileInline";
import { NoteLinkPreview } from "../TextRenderer/NoteLinkPreview";
import { CompactNoteText } from "../TextRenderer/CompactNoteText";

const ACTION = "promotion-action focus-pixel inline-flex min-h-11 items-center text-cyan-200/60";

function PreviewImage({ src, compact, expanded }: { src: string; compact: boolean; expanded: boolean }) {
    const [broken, setBroken] = useState(false);
    const size = compact ? 48 : 80;
    return <a href={src} target="_blank" rel="noopener noreferrer nofollow" aria-label="Open original image"
        className={`focus-pixel flex shrink-0 items-center justify-center border border-cyan-400/25 bg-void ${expanded ? "h-40 w-full" : ""}`}
        style={expanded ? undefined : { width: size, height: size }}>
        {broken ? <span className="promotion-label text-cyan-200/60">IMG</span> : <img src={src} alt="Image from the original note" loading="lazy" decoding="async"
            onError={() => setBroken(true)} className={`h-full w-full ${expanded ? "object-contain" : "object-cover"}`} />}
    </a>;
}

export function PromotionNotePreview({ preview, compact, expanded, onToggle, children }: {
    preview: NotePreview; compact: boolean; expanded: boolean; onToggle: () => void; children?: ReactNode;
}) {
    const images = useMemo(() => [...new Set([...preview.images, ...quoteImages(preview.event.content)])].filter((src) => /^https?:\/\//i.test(src)), [preview.images, preview.event.content]);
    const excerpt = useMemo(() => quotePreviewContent(preview.event.content), [preview.event.content]);
    const reading = <button type="button" className={`${ACTION} shrink-0`} aria-expanded={expanded} aria-label={expanded ? "Show less" : "Show full text"} onClick={onToggle}>
        {compact ? expanded ? "Less" : "Read" : expanded ? "Show less" : "Show full text"}
    </button>;
    const opening = <a href={njumpUrl(preview.event.id, "note")} target="_blank" rel="noopener noreferrer" aria-label="Open note"
        title={preview.active ? `Open note, #${preview.rank} in ${preview.rank <= 21 ? "main board" : "waiting room"}` : "Open note"}
        className={`${ACTION} shrink-0 gap-1 ${compact ? "min-w-11 justify-end" : ""}`}>
        {compact ? <><span>#{preview.rank}</span><svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="currentColor" shapeRendering="crispEdges">
            <path d="M4 0h8v8h-2V4H8v2H6v2H4v2H2v2H0v-2h2V8h2V6h2V4h2V2H4z" />
        </svg></> : "Open note"}
    </a>;
    return <article className={compact ? "space-y-1" : "space-y-3"} aria-label="Original note">
        <div className="flex items-center justify-between gap-2">
            <div className="min-w-0"><UserProfileInline pubkey={preview.event.pubkey} size={compact ? "sm" : "md"} /></div>
            {compact && <div className="flex shrink-0 items-center gap-2">{reading}{opening}</div>}
        </div>
        <div className="flex items-start gap-3">
            <div className={`${expanded ? "" : compact ? "line-clamp-2" : "line-clamp-3"} min-w-0 flex-1 text-sm leading-relaxed text-cyan-100`}>
                <CompactNoteText text={expanded ? preview.event.content : images.length && excerpt === "No text preview" ? "[Image]" : excerpt} />
            </div>
            {!expanded && images[0] && <PreviewImage key={images[0]} src={images[0]} compact={compact} expanded={false} />}
        </div>
        {expanded && <NoteLinkPreview text={preview.event.content} />}
        {expanded && images.length > 0 && <div className="grid grid-cols-2 gap-2" aria-label="Original note images">
            {images.map((src) => <PreviewImage key={src} src={src} compact={compact} expanded />)}
        </div>}
        {(!compact || children) && <div className="flex flex-wrap gap-x-3 text-xs text-cyan-200/60">
            {!compact && <>{reading}{opening}</>}{children}
        </div>}
    </article>;
}
