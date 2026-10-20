import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import Lightbox, { stopNavigationEventsPropagation, type ControllerRef, type Slide, type ZoomRef } from "yet-another-react-lightbox";
import Inline from "yet-another-react-lightbox/plugins/inline";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";
import { Modal } from "../primitives/Modal";
import { PixelButton, PixelLink } from "../primitives/PixelButton";
import { StatusMessage } from "../primitives/StatusMessage";
import { NoteVideo } from "./NoteVideo";
import { useMediaViewerHistory } from "../capabilities";
import { useMediaPresentation } from "./mediaPresentation";
import type { NoteMediaItem } from "../../core/content/noteMedia";
import "./NoteMediaViewer.css";

interface MediaVideoSlide { type: "note-video"; item: NoteMediaItem }
declare module "yet-another-react-lightbox" {
    interface SlideTypes { "note-video": MediaVideoSlide }
}
const PLUGINS = [Inline, Zoom];
const NO_TOOLBAR = { buttons: [] };
const CAROUSEL = { preload: 0, padding: "8px", spacing: "12px", imageFit: "contain" } as const;
interface Props {
    items: readonly NoteMediaItem[];
    index: number;
    onIndex: (index: number) => void;
    onClose: () => void;
    openerRef: RefObject<HTMLElement | null>;
}

export default function NoteMediaViewer({ items, index, onIndex, onClose, openerRef }: Props) {
    const { knownMedia, rememberMedia } = useMediaPresentation();
    const close = useMediaViewerHistory(onClose, openerRef);
    const controller = useRef<ControllerRef>(null);
    const zoom = useRef<ZoomRef>(null);
    const [zoomLevel, setZoomLevel] = useState(1);
    const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set(items.filter(item => knownMedia(item.src)?.failed).map(item => item.src)));
    const [reduceMotion, setReduceMotion] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
    const current = items[index] ?? items[0];
    // Slide identity survives index changes and parent rerenders with equal items.
    const itemKey = JSON.stringify(items);
    const slides = useMemo<Slide[]>(() => (JSON.parse(itemKey) as NoteMediaItem[]).map(item => {
        if (item.kind === "video") return { type: "note-video", item };
        const known = knownMedia(item.src);
        return { type: "image", src: item.src, alt: item.alt ?? "Image from the note", width: known?.width ?? item.width, height: known?.height ?? item.height };
    }), [itemKey]);
    useEffect(() => {
        const query = matchMedia("(prefers-reduced-motion: reduce)");
        const changed = () => setReduceMotion(query.matches);
        query.addEventListener("change", changed);
        return () => query.removeEventListener("change", changed);
    }, []);
    useEffect(() => {
        // Header and footer controls live outside the library's sensor container.
        const key = (event: KeyboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            const dialog = target?.closest('[role="dialog"]');
            if (!dialog?.classList.contains("note-media-viewer") || target?.closest(".yarl__root") || event.defaultPrevented) return;
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                if ((zoom.current?.zoom ?? 1) > 1) return;
                if (event.key === "ArrowLeft") controller.current?.prev();
                else controller.current?.next();
            }
        };
        document.addEventListener("keydown", key);
        return () => document.removeEventListener("keydown", key);
    }, []);
    if (!current) return null;
    return createPortal(<Modal isOpen onClose={close} title={`Media ${index + 1} of ${items.length}`}
        scrollBody mobileFullScreen aboveScanlines panelClassName="note-media-viewer" returnFocusRef={openerRef}>
        <div className="note-media-viewer__layout">
            <div className="note-media-viewer__stage" onLoadCapture={event => {
                const image = event.target;
                if (image instanceof HTMLImageElement && image.naturalWidth > 0 && image.naturalHeight > 0 && Number.isFinite(image.naturalWidth) && Number.isFinite(image.naturalHeight)) {
                    rememberMedia(image.getAttribute("src") ?? image.src, { width: image.naturalWidth, height: image.naturalHeight, failed: false });
                }
            }} onErrorCapture={event => {
                const image = event.target;
                if (!(image instanceof HTMLImageElement)) return;
                const src = image.getAttribute("src") ?? image.src;
                rememberMedia(src, { failed: true });
                setFailed(previous => new Set(previous).add(src));
            }}>
                <Lightbox slides={slides} index={index} plugins={PLUGINS} toolbar={NO_TOOLBAR} carousel={CAROUSEL}
                    controller={{ ref: controller, closeOnEscape: false, closeOnBackdropClick: false, touchAction: "none" }}
                    animation={{ fade: 0, swipe: reduceMotion ? 0 : 220, navigation: reduceMotion ? 0 : 220, zoom: reduceMotion ? 0 : 180 }}
                    zoom={{ ref: zoom, maxZoomPixelRatio: 2 }}
                    on={{ view: ({ index: next }) => onIndex(next), zoom: ({ zoom: value }) => setZoomLevel(value) }}
                    render={{
                        iconLoading: () => <StatusMessage loading compact>Loading media</StatusMessage>,
                        buttonPrev: () => null,
                        buttonNext: () => null,
                        buttonZoom: state => {
                            const disabled = state.disabled || current.kind !== "image";
                            return <div className="note-media-viewer__zoom" aria-label="Image zoom">
                                <PixelButton variant="ghost" size="sm" className="note-media-viewer__icon" aria-label="Zoom out" disabled={disabled || state.zoom <= state.minZoom} onClick={state.zoomOut}><svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="currentColor" shapeRendering="crispEdges"><path d="M1 6h12v2H1z" /></svg></PixelButton>
                                <PixelButton variant="ghost" size="sm" className="note-media-viewer__icon" aria-label="Zoom in" disabled={disabled || state.zoom >= state.maxZoom} onClick={state.zoomIn}><svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="currentColor" shapeRendering="crispEdges"><path d="M6 1h2v5h5v2H8v5H6V8H1V6h5z" /></svg></PixelButton>
                            </div>;
                        },
                        // Keep inactive slides inert even if the carousel preload changes.
                        slide: ({ slide, offset }) => {
                            if (offset !== 0) return <span aria-hidden="true" />;
                            if (slide.type === "note-video") return <div className="note-media-viewer__video" {...stopNavigationEventsPropagation()}><NoteVideo key={slide.item.src} item={slide.item} active={offset === 0} /></div>;
                            if (!failed.has(slide.src)) return undefined;
                            return <div className="note-media-viewer__failure">
                                <StatusMessage>Image unavailable</StatusMessage>
                                <PixelButton variant="ghost" size="sm" onClick={() => setFailed(previous => { const next = new Set(previous); next.delete(slide.src); return next; })}>Retry image</PixelButton>
                                <a className="focus-pixel" href={slide.src} target="_blank" rel="noopener noreferrer nofollow">Open source ↗</a>
                            </div>;
                        },
                    }} />
            </div>
            <div className="note-media-viewer__navigation">
                <PixelButton variant="ghost" size="sm" className="note-media-viewer__icon" aria-label="Previous media" disabled={items.length < 2} onClick={() => controller.current?.prev()}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" shapeRendering="crispEdges"><path d="M6 2h2v2H6v2H4v1h10v2H4v1h2v2h2v2H6v-2H4v-2H2V9H0V7h2V6h2V4h2z" /></svg></PixelButton>
                <PixelLink variant="ghost" size="sm" className="note-media-viewer__source" href={current.src} target="_blank" rel="noopener noreferrer nofollow">Open source ↗</PixelLink>
                <PixelButton variant="ghost" size="sm" className="note-media-viewer__icon" aria-label="Next media" disabled={items.length < 2} onClick={() => controller.current?.next()}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" shapeRendering="crispEdges"><path d="M8 2h2v2h2v2h2v1h2v2h-2v1h-2v2h-2v2H8v-2h2v-2h2V9H2V7h10V6h-2V4H8z" /></svg></PixelButton>
            </div>
            <span className="sr-only" aria-live="polite">{current.kind === "image" && zoomLevel > 1 ? `Zoom ${Math.round(zoomLevel * 100)} percent` : ""}</span>
        </div>
    </Modal>, document.body);
}
