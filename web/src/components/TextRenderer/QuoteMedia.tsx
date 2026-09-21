import { useState } from "react";

const MAX_VISIBLE = 3;

/** A fixed-height preview keeps media useful without letting it take over the ranked row. */
export function QuoteMedia({ images }: { images: string[] }) {
    const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
    if (!images.length) return null;
    const available = images.filter(src => !failed.has(src));
    const visible = available.slice(0, MAX_VISIBLE);
    const remaining = available.length - visible.length;
    if (!visible.length) return <p className="mt-2 text-[10px] text-cyan-100/40">Images unavailable</p>;

    return <div className="note-quote__media" aria-label={`${available.length} ${available.length === 1 ? "image" : "images"} in quoted note`}>
        {visible.map((src, index) => <a key={src} href={src} target="_blank" rel="noopener noreferrer nofollow"
            aria-label={`Open image ${index + 1} of ${available.length}`}>
            <img src={src} alt="" decoding="async"
                onError={() => setFailed(current => new Set(current).add(src))} />
            {index === visible.length - 1 && remaining > 0 && <span className="note-quote__media-more">+{remaining}</span>}
        </a>)}
    </div>;
}
