import { useState } from "react";
import type { NoteMediaItem } from "../../lib/noteMedia";
import { knownMedia, rememberMedia } from "../../lib/mediaPresentation";
import { useNoteVideo } from "../../hooks/useNoteVideo";
import "./NoteVideo.css";
export function NoteVideo({ item, active = true, onDimensions }: {
    item: NoteMediaItem; active?: boolean; onDimensions?: (width: number, height: number) => void;
}) {
    const [admitted, setAdmitted] = useState(false);
    const [started, setStarted] = useState(false);
    const [failed, setFailed] = useState(() => !!knownMedia(item.src)?.failed);
    const [posterFailed, setPosterFailed] = useState(false);
    const { ref, visible } = useNoteVideo(item.src, active);
    if (active && visible && !admitted) setAdmitted(true);
    const placeholder = !started && (!item.poster || posterFailed);
    return <div className="note-video" data-note-block>
        <video ref={ref} className="note-content-video" src={admitted && !failed ? item.src : undefined}
            poster={posterFailed ? undefined : item.poster} controls playsInline preload="metadata" tabIndex={0}
            aria-label={item.alt || "Video"} onPlay={event => {
                const video = event.currentTarget, bounds = video.getBoundingClientRect();
                if (!active || document.hidden || video.closest("[hidden]") || bounds.bottom <= 0 || bounds.top >= innerHeight) { video.pause(); return; }
                setStarted(true);
            }}
            onLoadedMetadata={event => { const video = event.currentTarget; if (video.videoWidth && video.videoHeight) onDimensions?.(video.videoWidth, video.videoHeight); }}
            onError={() => { rememberMedia(item.src, { failed: true }); setFailed(true); }} />
        {item.poster && !posterFailed && <img className="note-video-poster-probe" src={item.poster} alt="" onError={() => setPosterFailed(true)} />}
        {placeholder && !failed && <button type="button" className="note-video-start focus-pixel" aria-label="Play video" disabled={!active}
            onClick={() => { setStarted(true); void ref.current?.play().catch(() => setStarted(false)); }}>
            <svg viewBox="0 0 24 24" width="36" height="36" aria-hidden="true"><path fill="currentColor" d="M5 3h4v2h4v2h4v2h4v2h4v6h-4v2h-4v2h-4v2H9v2H5z" /></svg><span>Video</span>
        </button>}
        {failed && <div className="note-video-failure" role="status"><span>Video unavailable</span>
            <button type="button" className="note-action focus-pixel" onClick={() => { rememberMedia(item.src, { failed: false }); setFailed(false); setStarted(false); }}>Retry</button>
            <a className="note-action focus-pixel" href={item.src} target="_blank" rel="noopener noreferrer">Open source</a>
        </div>}
    </div>;
}
