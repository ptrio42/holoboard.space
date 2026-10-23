import { safeMediaSource, type NoteMediaItem } from '../../core/content/noteMedia';
import type { ContentPolicy } from '../../core/ports';

type MediaPolicy = Pick<ContentPolicy, 'mediaAllowed'>;
/** Host permission supplements URL safety; it cannot admit executable sources. */
export function mediaAllowed(policy: MediaPolicy, source: string): boolean {
    return safeMediaSource(source) && policy.mediaAllowed(source);
}
export function admittedMediaItem(policy: MediaPolicy, item: NoteMediaItem): NoteMediaItem | undefined {
    if (!mediaAllowed(policy, item.src)) return undefined;
    return { ...item, poster: item.poster && mediaAllowed(policy, item.poster) ? item.poster : undefined };
}
