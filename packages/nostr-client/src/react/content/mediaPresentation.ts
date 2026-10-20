import { useCallback, useId, useSyncExternalStore } from "react";
import { useClient } from "../ClientProvider";
import type { NoteMediaItem } from "../../core/content/noteMedia";
export type MediaState = { width?: number; height?: number; failed?: boolean; time?: number };
const lifetime = 30 * 60_000;
function trim<T>(map: Map<string, T>, limit: number) { while (map.size > limit) map.delete(map.keys().next().value!); }
export function createMediaPresentation() {
const media = new Map<string, { value: MediaState; expires: number; failureExpires: number }>();
const selections = new Map<string, { src: string; expires: number }>();
const listeners = new Map<string, Set<() => void>>();
function trim<T>(map: Map<string, T>, limit: number) { while (map.size > limit) map.delete(map.keys().next().value!); }
/** Bounded presentation state, independent of identity and signed events. */
function knownMedia(src: string): MediaState | undefined {
    const item = media.get(src);
    if (!item) return undefined;
    if (item.expires <= Date.now()) { media.delete(src); return undefined; }
    if (item.value.failed && item.failureExpires <= Date.now()) item.value = { ...item.value, failed: false };
    return item.value;
}
function rememberMedia(src: string, patch: MediaState): void {
    if (src.length > 2048) return;
    const value = { ...knownMedia(src), ...patch };
    if (!Number.isFinite(value.time) || value.time! < 0) delete value.time;
    if (!Number.isFinite(value.width) || value.width! <= 0 || !Number.isFinite(value.height) || value.height! <= 0) { delete value.width; delete value.height; }
    media.delete(src);
    media.set(src, { value, expires: Date.now() + lifetime, failureExpires: Date.now() + 60_000 });
    trim(media, 512);
}
return { media, selections, listeners, knownMedia, rememberMedia };
}
export function useMediaSelection(key: string, items: readonly NoteMediaItem[]): [string, (src: string) => void] {
    const { selections, listeners } = useClient().presentation;
    const localKey = useId();
    const identity = key && key.length <= 16384 ? key : localKey;
    const subscribe = useCallback((listener: () => void) => {
        const set = listeners.get(identity) ?? new Set(); set.add(listener); listeners.set(identity, set);
        return () => { set.delete(listener); if (!set.size) listeners.delete(identity); };
    }, [identity]);
    const snapshot = useCallback(() => {
        const selected = selections.get(identity);
        return selected && selected.expires > Date.now() ? selected.src : "";
    }, [identity]);
    const selected = useSyncExternalStore(subscribe, snapshot, () => "");
    const select = useCallback((src: string) => {
        if (!items.some(item => item.src === src)) return;
        selections.delete(identity); selections.set(identity, { src, expires: Date.now() + lifetime }); trim(selections, 128);
        listeners.get(identity)?.forEach(listener => listener());
    }, [identity, items]);
    return [items.some(item => item.src === selected) ? selected : items[0]?.src ?? "", select];
}

export function useMediaPresentation() { return useClient().presentation; }
