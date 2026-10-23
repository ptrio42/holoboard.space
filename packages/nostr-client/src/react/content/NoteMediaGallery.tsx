import { useClient } from "../ClientProvider";
import { useSyncExternalStore } from "react";
import { lazy, Suspense, useLayoutEffect, useRef, useState, type CSSProperties, type TouchEvent } from "react";
import { useMediaPresentation, useMediaSelection } from "./mediaPresentation";
import type { NoteMediaItem } from "../../core/content/noteMedia";
import { PixelButton } from "../primitives/PixelButton";
import { StatusMessage } from "../primitives/StatusMessage";
import { admittedMediaItem } from "./mediaAdmission";
import { MediaSourceLinks } from "./MediaSourceLinks";
import { NoteVideo } from "./NoteVideo";
import "./NoteMediaGallery.css";

const NoteMediaViewer = lazy(() => import("./NoteMediaViewer"));
const EMPTY_IMAGES: string[] = [];

interface NoteMediaGalleryProps {
    images?: string[];
    items?: readonly NoteMediaItem[];
    quoted?: boolean;
    galleryKey?: string;
}

/** One complete frame, with source order and selection preserved across readers. */
export function NoteMediaGallery({ images = EMPTY_IMAGES, items, quoted = false, galleryKey }: NoteMediaGalleryProps) {
    const { knownMedia, rememberMedia } = useMediaPresentation();
function dimensions(item: NoteMediaItem | undefined) {
    if (!item) return undefined;
    const observed = knownMedia(item.src);
    const width = observed?.width ?? item.width;
    const height = observed?.height ?? item.height;
    return width && height && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width <= 100000 && height <= 100000
        ? { width, height } : undefined;
}


    const policy = useClient().policy;
    useSyncExternalStore(policy.onChange, () => policy.generation, () => policy.generation);
    const sources = items ?? images.map((src): NoteMediaItem => ({ kind: "image", src }));
    const admitted = sources.map(item => admittedMediaItem(policy, item));
    const denied = sources.filter((_, index) => !admitted[index]);
    const media: readonly NoteMediaItem[] = admitted.filter((item): item is NoteMediaItem => !!item);
    const identity = galleryKey ?? JSON.stringify(media.map(item => [item.kind, item.src]));
    const [selected, select] = useMediaSelection(identity, media);
    const [viewerOpen, setViewerOpen] = useState(false);
    const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set(media.filter(item => knownMedia(item.src)?.failed).map(item => item.src)));
    const [retries, setRetries] = useState<Record<string, number>>({});
    const [observed, setObserved] = useState<Record<string, { width: number; height: number }>>({});
    const opener = useRef<HTMLElement | null>(null);
    const root = useRef<HTMLDivElement>(null);
    const touch = useRef<{ x: number; y: number } | null>(null);
    const suppressOpenUntil = useRef(0);
    useLayoutEffect(() => {
        if (viewerOpen) opener.current = root.current?.querySelector<HTMLElement>(".note-gallery__image, .note-gallery__expand") ?? root.current;
    }, [viewerOpen, selected, failed]);
    useLayoutEffect(() => {
        if (!viewerOpen) return;
        const openingURL = window.location.href;
        // Navigation can finish before the viewer's lazy module and history owner load.
        const cancelPendingViewer = () => { if (window.location.href !== openingURL) setViewerOpen(false); };
        window.addEventListener("popstate", cancelPendingViewer);
        return () => window.removeEventListener("popstate", cancelPendingViewer);
    }, [viewerOpen]);
    if (!media.length) return <MediaSourceLinks items={denied} />;

    const index = Math.max(0, media.findIndex(item => item.src === selected));
    const item = media[index];
    const firstDimensions = observed[media[0].src] ?? dimensions(media[0]);
    const firstRatio = firstDimensions ? firstDimensions.width / firstDimensions.height : media.length > 1 ? 1 : 4 / 3;
    // A wide first slide must leave enough room for later portraits and controls.
    const frameRatio = media.length > 1 ? Math.min(1, firstRatio) : firstRatio;
    const frameStyle = { "--gallery-ratio": frameRatio } as CSSProperties;
    const start = Math.max(0, Math.min(index - 3, media.length - 7));
    const thumbnails = media.slice(start, start + 7);
    const unavailable = failed.has(item.src) || knownMedia(item.src)?.failed;

    const change = (step: number) => select(media[(index + step + media.length) % media.length].src);
    const loaded = (src: string, width: number, height: number) => {
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
        rememberMedia(src, { width, height, failed: false });
        setObserved(current => current[src]?.width === width && current[src]?.height === height ? current : { ...current, [src]: { width, height } });
        setFailed(current => {
            if (!current.has(src)) return current;
            const next = new Set(current);
            next.delete(src);
            return next;
        });
    };
    const fail = (src: string) => {
        rememberMedia(src, { failed: true });
        setFailed(current => new Set(current).add(src));
    };
    const retry = () => {
        rememberMedia(item.src, { failed: false });
        setFailed(current => {
            const next = new Set(current);
            next.delete(item.src);
            return next;
        });
        setRetries(current => ({ ...current, [item.src]: (current[item.src] ?? 0) + 1 }));
    };
    const open = (button: HTMLElement) => {
        if (Date.now() < suppressOpenUntil.current) return;
        opener.current = button;
        const video = root.current?.querySelector("video");
        if (video) {
            video.pause();
            if (video.readyState >= 1 && Number.isFinite(video.currentTime)) rememberMedia(item.src, { time: video.currentTime });
        }
        setViewerOpen(true);
    };
    const closeViewer = () => {
        setViewerOpen(false);
        setFailed(current => new Set([...current].filter(src => knownMedia(src)?.failed !== false)));
    };
    const touchStart = (event: TouchEvent) => {
        touch.current = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
    };
    const touchEnd = (event: TouchEvent) => {
        const origin = touch.current;
        touch.current = null;
        if (!origin || !event.changedTouches.length) return;
        const dx = event.changedTouches[0].clientX - origin.x;
        const dy = event.changedTouches[0].clientY - origin.y;
        if (Math.abs(dx) < 40 || Math.abs(dx) <= Math.abs(dy) * 1.3) return;
        suppressOpenUntil.current = Date.now() + 600;
        if (media.length > 1) change(dx < 0 ? 1 : -1);
    };

    return <>
        <div ref={root} tabIndex={-1} className={`note-gallery note-gallery--lead${media.length > 1 ? " note-gallery--multiple" : ""}${quoted ? " note-gallery--quoted" : ""}`}
            aria-label={`${media.length} media ${quoted ? "in quoted note" : "in note"}`} data-note-block data-media-index={index} data-media-shape={frameRatio < .85 ? "portrait" : "landscape"}>
            <div className="note-gallery__lead" style={frameStyle}>
                {item.kind === "image" ? unavailable ?
                    <div className="note-gallery__unavailable"><StatusMessage compact>Image unavailable</StatusMessage></div> :
                    <button type="button" className="note-gallery-image note-gallery__image focus-pixel"
                        aria-label={`Open image ${index + 1} of ${media.length}`} onClick={event => open(event.currentTarget)}
                        onTouchStart={touchStart} onTouchMove={event => { if (event.touches.length !== 1) touch.current = null; }}
                        onTouchEnd={touchEnd} onTouchCancel={() => { touch.current = null; }}>
                        <img key={`${item.src}:${retries[item.src] ?? 0}`} src={item.src} alt={item.alt ?? "Image from the note"} loading="lazy" decoding="async"
                            onLoad={event => loaded(item.src, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} onError={() => fail(item.src)} />
                    </button> :
                    <NoteVideo key={item.src} item={item} active={!viewerOpen} onDimensions={(width, height) => loaded(item.src, width, height)} />}
                {(media.length > 1 || item.kind === "video") && <div className="note-gallery__toolbar">
                    {media.length > 1 && <>
                        <PixelButton variant="ghost" size="sm" className="note-gallery__arrow" onClick={() => change(-1)} aria-label="Previous media"><span aria-hidden="true">◀</span></PixelButton>
                        <span className="note-gallery__counter" role="status" aria-label={`${item.kind === "image" ? "Image" : "Video"} ${index + 1} of ${media.length}`}>{index + 1} / {media.length}</span>
                        <PixelButton variant="ghost" size="sm" className="note-gallery__arrow" onClick={() => change(1)} aria-label="Next media"><span aria-hidden="true">▶</span></PixelButton>
                    </>}
                    {item.kind === "video" && <PixelButton variant="ghost" size="sm" className="note-gallery__expand" onClick={event => open(event.currentTarget)} aria-label={`Open video ${index + 1} of ${media.length}`} title="Expand video">
                        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" shapeRendering="crispEdges"><path d="M0 0h6v2H2v4H0zM10 0h6v6h-2V2h-4zM0 10h2v4h4v2H0zM14 10h2v6h-6v-2h4z" /></svg>
                    </PixelButton>}
                </div>}
            </div>
            {item.kind === "image" && unavailable && <div className="note-gallery__recovery">
                <a className="note-media-unavailable" href={item.src} target="_blank" rel="noopener noreferrer nofollow">Open source ↗</a>
                <PixelButton variant="ghost" size="sm" onClick={retry}>Retry image</PixelButton>
            </div>}
            {media.length > 1 && <div className="note-gallery__thumbnails" role="group" aria-label="Choose media">
                {thumbnails.map((thumbnail, offset) => {
                    const number = start + offset;
                    const broken = failed.has(thumbnail.src) || knownMedia(thumbnail.src)?.failed;
                    const preview = thumbnail.kind === "image" ? thumbnail.src : thumbnail.poster;
                    return <button key={thumbnail.src} type="button" className="note-gallery__thumbnail focus-pixel" aria-pressed={number === index}
                        ref={node => { if (node && number === index && node.parentElement) node.parentElement.scrollLeft = node.offsetLeft - (node.parentElement.clientWidth - node.clientWidth) / 2; }}
                        aria-label={`Select ${thumbnail.kind} ${number + 1} of ${media.length}${broken ? ", unavailable" : ""}`} onClick={() => select(thumbnail.src)}>
                        {preview && !broken && <img src={preview} alt="" loading="lazy" decoding="async" onError={event => { event.currentTarget.hidden = true; }} />}
                        {thumbnail.kind === "video" && <span className="note-gallery__play" aria-hidden="true">▶</span>}
                        <span className="note-gallery__thumbnail-number" aria-hidden="true">{broken ? "! " : ""}{number + 1}</span>
                    </button>;
                })}
            </div>}
        </div>
        <MediaSourceLinks items={denied} />
        {viewerOpen && <Suspense fallback={<div className="note-gallery-viewer-loading"><StatusMessage loading compact>Opening media</StatusMessage></div>}>
            <NoteMediaViewer items={media} index={index} onIndex={next => { if (media[next]) select(media[next].src); }} onClose={closeViewer} openerRef={opener} />
        </Suspense>}
    </>;
}
