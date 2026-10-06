import { useEffect, useMemo, useRef, useState } from "react";
import { fetchLinkPreview, firstPreviewLink, type LinkPreview } from "../../lib/linkPreview";

export function NoteLinkPreview({ text }: { text: string }) {
    const url = useMemo(() => firstPreviewLink(text), [text]);
    // Reset observers, metadata and broken-image state when a note changes.
    return url ? <PreviewCard key={url} url={url} /> : null;
}

function PreviewCard({ url }: { url: string }) {
    const container = useRef<HTMLDivElement>(null);
    const [preview, setPreview] = useState<LinkPreview | null>(null);
    const [brokenImage, setBrokenImage] = useState(false);
    useEffect(() => {
        let active = true;
        const observer = new IntersectionObserver(([entry]) => {
            if (!entry.isIntersecting || container.current?.closest("[inert]")) return;
            observer.disconnect();
            void fetchLinkPreview(url).then((result) => { if (active) setPreview(result); });
        }, { rootMargin: "200px" });
        if (container.current) observer.observe(container.current);
        return () => { active = false; observer.disconnect(); };
    }, [url]);

    // WebKit needs a nonzero target area to observe an empty, clipped placeholder.
    return <div ref={container} style={{ minHeight: 1 }} data-note-block={preview ? "" : undefined}>
        {preview && <a href={url} target="_blank" rel="noopener noreferrer nofollow" aria-label={`Open link: ${preview.title}`}
            className="note-link-preview focus-pixel">
            {preview.imageUrl && !brokenImage && <img src={preview.imageUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBrokenImage(true)} />}
            <span className="min-w-0 flex-1 space-y-1">
                <span className="block font-pixel text-[8px] leading-relaxed text-cyan-200/60 break-all">{new URL(preview.url).hostname}</span>
                <span className="block line-clamp-2 text-sm text-cyan-100">{preview.title}</span>
                {preview.description && <span className="block line-clamp-2 text-xs text-cyan-100/60">{preview.description}</span>}
            </span>
        </a>}
    </div>;
}
