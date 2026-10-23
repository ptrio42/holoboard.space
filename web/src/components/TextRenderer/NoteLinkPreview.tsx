import { useEffect, useMemo, useRef, useState } from "react";
import { cachedLinkPreview, fetchLinkPreview, firstPreviewLink, type LinkPreview } from "../../lib/linkPreview";

export function NoteLinkPreview({ text, url: explicitUrl, compact = false }: { text: string; url?: string | null; compact?: boolean }) {
    const url = useMemo(() => explicitUrl === undefined ? firstPreviewLink(text) : explicitUrl, [text, explicitUrl]);
    // Reset observers, metadata and broken-image state when a note changes.
    return url ? <PreviewCard key={url} url={url} compact={compact} /> : null;
}

function PreviewCard({ url, compact }: { url: string; compact: boolean }) {
    const container = useRef<HTMLDivElement>(null);
    const [preview, setPreview] = useState<LinkPreview | null>(() => cachedLinkPreview(url));
    const [settled, setSettled] = useState(!!preview);
    const [brokenImage, setBrokenImage] = useState(false);
    useEffect(() => {
        let active = true;
        // A modal's scrolling body clips its descendants before the window's
        // root margin applies. Observe that scrollport so nearby cards can load.
        const observer = new IntersectionObserver(([entry]) => {
            if (!entry.isIntersecting || container.current?.closest("[inert]")) return;
            observer.disconnect();
            void fetchLinkPreview(url).then((result) => { if (active) { setPreview(result); setSettled(true); } });
        }, { root: container.current?.closest("[data-modal-body]") ?? null, rootMargin: "200px" });
        if (container.current) observer.observe(container.current);
        return () => { active = false; observer.disconnect(); };
    }, [url]);

    // WebKit needs a nonzero target area to observe an empty, clipped placeholder.
    return <div ref={container} className="note-link-container" style={{ minHeight: 1 }} data-preview-state={preview ? "ready" : settled ? "unavailable" : "loading"} data-note-block={preview ? "" : undefined}>
        {preview && <a href={url} target="_blank" rel="noopener noreferrer nofollow" aria-label={`Open link: ${preview.title}`}
            className={`note-link-preview focus-pixel${compact ? " note-link-preview--compact" : ""}`}>
            {preview.imageUrl && !brokenImage && <img src={preview.imageUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBrokenImage(true)} />}
            <span className="min-w-0 flex-1 space-y-1">
                <span className={`${compact ? "line-clamp-1" : "block"} font-pixel text-[10px] leading-relaxed text-cyan-200/60 break-all`}>{new URL(preview.url).hostname}</span>
                <span className={`${compact ? "line-clamp-1" : "line-clamp-2"} text-sm text-cyan-100`}>{preview.title}</span>
                {preview.description && <span className={`${compact ? "line-clamp-1" : "line-clamp-2"} text-xs text-cyan-100/60`}>{preview.description}</span>}
            </span>
        </a>}
    </div>;
}
