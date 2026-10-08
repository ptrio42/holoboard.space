import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "../ui/Modal";
import { PixelButton } from "../ui/PixelButton";

// Presentation only: preserve a loaded card's geometry during reader handoff.
const imagePresentation = new Map<string, { ratio?: number; failed?: boolean; expires: number }>();
function knownImage(src: string) {
    const value = imagePresentation.get(src);
    return value && value.expires > Date.now() ? value : undefined;
}
function rememberImage(src: string, ratio?: number) {
    imagePresentation.delete(src);
    if (imagePresentation.size >= 512) imagePresentation.delete(imagePresentation.keys().next().value!);
    imagePresentation.set(src, ratio ? { ratio, expires: Date.now() + 1800000 } : { failed: true, expires: Date.now() + 60000 });
}

export function NoteMediaGallery({ images, quoted = false }: { images: string[]; quoted?: boolean }) {
    const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set(images.filter(src => knownImage(src)?.failed)));
    const [ratios, setRatios] = useState<Record<string, number>>(() => Object.fromEntries(images.flatMap(src => {
        const ratio = knownImage(src)?.ratio;
        return ratio ? [[src, ratio]] : [];
    })));
    const [viewer, setViewer] = useState<{ images: string[]; index: number } | null>(null);
    const [viewerFailed, setViewerFailed] = useState(false);
    const opener = useRef<HTMLButtonElement>(null);
    if (!images.length) return null;
    const available = images.filter(src => !failed.has(src));
    const visible = available.slice(0, 4);
    const portraits = visible.length > 1 && visible.length <= 3 && visible.every(src => ratios[src] > 0 && ratios[src] <= 0.85);
    const change = (step: number) => { setViewer(value => value && { ...value, index: (value.index + value.images.length + step) % value.images.length }); setViewerFailed(false); };
    if (!visible.length) return <a className="note-media-unavailable" href={images[0]} target="_blank" rel="noopener noreferrer nofollow">Images unavailable. Open source ↗</a>;
    return <>
        <div className={`note-gallery gallery-${visible.length}${quoted ? " note-gallery--quoted" : ""}${portraits ? " gallery-portraits" : ""}`}
            style={portraits ? { gridTemplateColumns: visible.map(src => `${ratios[src]}fr`).join(" ") } : undefined}
            aria-label={`${available.length} ${available.length === 1 ? "image" : "images"}${quoted ? " in quoted note" : " in note"}`} data-note-block>
            {visible.map((src, index) => <button key={src} type="button" className="note-gallery-image focus-pixel"
                style={portraits ? { aspectRatio: ratios[src] } : undefined} aria-label={`Open image ${index + 1} of ${available.length}`}
                onClick={event => { opener.current = event.currentTarget; setViewerFailed(false); setViewer({ images: available, index }); }}>
                <img src={src} alt="Image from the note" loading="lazy" decoding="async" onLoad={event => {
                    const image = event.currentTarget;
                    const ratio = image.naturalWidth / image.naturalHeight;
                    rememberImage(src, ratio);
                    setRatios(current => ({ ...current, [src]: ratio }));
                }} onError={() => { rememberImage(src); setFailed(current => new Set(current).add(src)); }} />
                {index === visible.length - 1 && available.length > visible.length && <span className="note-gallery-more">+{available.length - visible.length}</span>}
            </button>)}
        </div>
        {viewer && createPortal(<Modal isOpen onClose={() => setViewer(null)} title={`Image ${viewer.index + 1} of ${viewer.images.length}`}
            scrollBody panelClassName="note-image-viewer" returnFocusRef={opener}>
            <div onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); change(event.key === "ArrowLeft" ? -1 : 1); } }}>
                {viewerFailed ? <p role="status">Image unavailable. Open its source below.</p> : <img className="note-image-viewer__image"
                    src={viewer.images[viewer.index]} alt="Full image from the original note" onError={() => setViewerFailed(true)} />}
                <div className="note-image-viewer__navigation">
                    {viewer.images.length > 1 && <PixelButton variant="ghost" size="sm" onClick={() => change(-1)} aria-label="Previous image">Previous</PixelButton>}
                    <a className="note-action" href={viewer.images[viewer.index]} target="_blank" rel="noopener noreferrer nofollow">Open source ↗</a>
                    {viewer.images.length > 1 && <PixelButton variant="ghost" size="sm" onClick={() => change(1)} aria-label="Next image">Next</PixelButton>}
                </div>
            </div>
        </Modal>, document.body)}
    </>;
}
