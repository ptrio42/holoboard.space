import { useEffect, useState } from "react";
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
    useEffect(() => {
        const video = ref.current;
        if (!video || !active || !visible || item.poster && !posterFailed) return;
        const revealFrame = () => {
            if (video.readyState < 1 || video.currentTime !== 0 || knownMedia(item.src)?.time !== undefined || !Number.isFinite(video.duration) || video.duration <= 0) return;
            // A small explicit seek exposes a paused frame on browsers that stop at metadata.
            video.currentTime = Math.min(.05, video.duration / 2);
        };
        video.addEventListener("loadedmetadata", revealFrame);
        revealFrame();
        return () => video.removeEventListener("loadedmetadata", revealFrame);
    }, [active, visible, item.src, item.poster, posterFailed, ref]);
    return <div className="note-video" data-note-block>
        <video ref={ref} className="note-content-video" src={admitted && !failed ? item.src : undefined}
            poster={posterFailed ? undefined : item.poster} controls playsInline preload="metadata" tabIndex={0}
            aria-label={item.alt || "Video"} onPlay={event => {
                const video = event.currentTarget, bounds = video.getBoundingClientRect();
                if (!active || document.hidden || video.closest("[hidden]") || bounds.bottom <= 0 || bounds.top >= innerHeight) { video.pause(); return; }
                setStarted(true);
            }}
            onLoadedMetadata={event => {
                const video = event.currentTarget;
                if (video.videoWidth && video.videoHeight) onDimensions?.(video.videoWidth, video.videoHeight);
            }}
            onError={() => { rememberMedia(item.src, { failed: true }); setFailed(true); }} />
        {item.poster && !posterFailed && <img className="note-video-poster-probe" src={item.poster} alt="" onError={() => setPosterFailed(true)} />}
        {!started && !failed && <button type="button" className="note-video-start focus-pixel" aria-label="Play video" disabled={!active}
            onClick={() => { setStarted(true); void ref.current?.play().catch(() => setStarted(false)); }}>
            <span className="note-video-start__label"><svg viewBox="0 0 24 24" width="36" height="36" aria-hidden="true"><path fill="currentColor" d="M5 3h4v2h4v2h4v2h4v2h4v6h-4v2h-4v2h-4v2H9v2H5z" /></svg><span>Video</span></span>
        </button>}
        {failed && <div className="note-video-failure" role="status"><span>Video unavailable</span>
            <button type="button" className="note-action focus-pixel" onClick={() => { rememberMedia(item.src, { failed: false }); setFailed(false); setStarted(false); }}>Retry</button>
            <a className="note-action focus-pixel" href={item.src} target="_blank" rel="noopener noreferrer">Open source</a>
        </div>}
    </div>;
}
