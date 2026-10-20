import type { NoteMediaItem } from '../../core/content/noteMedia';
import { linkLabel } from '../../core/content/noteAttachments';

export function mediaSourceUrl(value: string): string | undefined {
    try {
        const url = new URL(value);
        if (value.length <= 2048 && /^https?:$/.test(url.protocol) && !url.username && !url.password) return url.href;
    } catch { /* Unsafe sources cannot become navigation targets. */ }
}
/** Source navigation is explicit and performs no media or preview requests. */
export function MediaSourceLinks({ items }: { items: readonly NoteMediaItem[] }) {
    const sources = items.flatMap(item => { const href = mediaSourceUrl(item.src); return href ? [{ ...item, href }] : []; });
    if (!sources.length) return null;
    return <div className="note-media-sources" data-note-block>
        <p role="status">Media preview unavailable. Open the source to view it.</p>
        <ul aria-label="Media sources">{sources.map((item, index) => <li key={`${index}:${item.src}`}>
            <a href={item.href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" className="focus-pixel">
                {item.kind === 'image' ? 'Image' : 'Video'} source: {linkLabel(item.href)}
            </a>
        </li>)}</ul>
    </div>;
}
