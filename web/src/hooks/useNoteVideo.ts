import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { knownMedia, rememberMedia } from "../lib/mediaPresentation";
const videos = new Map<HTMLVideoElement, { visible: (visible: boolean) => void; save: () => void }>();
let observer: IntersectionObserver | undefined;
const pauseVideo = (video: HTMLVideoElement) => { videos.get(video)?.save(); video.pause(); };
export const pauseNoteVideos = () => videos.forEach((_, video) => pauseVideo(video));
const onVisibility = () => { if (document.hidden) pauseNoteVideos(); };
const onPlay = (event: Event) => {
    const active = event.currentTarget as HTMLVideoElement;
    videos.forEach((_, video) => { if (video !== active) pauseVideo(video); });
};
function register(video: HTMLVideoElement, visible: (visible: boolean) => void, save: () => void) {
    if (!videos.size) {
        observer = new IntersectionObserver(entries => entries.forEach(entry => {
            const target = entry.target as HTMLVideoElement;
            if (!entry.isIntersecting) pauseVideo(target);
            videos.get(target)?.visible(entry.isIntersecting);
        }));
        document.addEventListener("visibilitychange", onVisibility); window.addEventListener("popstate", pauseNoteVideos);
    }
    videos.set(video, { visible, save }); observer?.observe(video); video.addEventListener("play", onPlay);
    return () => {
        video.pause(); video.removeEventListener("play", onPlay); observer?.unobserve(video); videos.delete(video);
        if (!videos.size) {
            observer?.disconnect(); observer = undefined;
            document.removeEventListener("visibilitychange", onVisibility); window.removeEventListener("popstate", pauseNoteVideos);
        }
    };
}
export function useNoteVideo(src: string, active: boolean) {
    const ref = useRef<HTMLVideoElement>(null);
    const [visible, setVisible] = useState(false);
    const owner = useRef(active);
    useLayoutEffect(() => { owner.current = active && visible; }, [active, visible]);
    useEffect(() => {
        const video = ref.current;
        if (!video) return;
        let ready = false;
        const save = () => { if (owner.current && ready && Number.isFinite(video.currentTime)) rememberMedia(src, { time: video.currentTime }); };
        const restore = () => {
            const time = knownMedia(src)?.time;
            if (time !== undefined && Number.isFinite(video.duration)) video.currentTime = Math.min(time, Math.max(0, video.duration - .05));
            ready = true;
            if (video.videoWidth && video.videoHeight) rememberMedia(src, { width: video.videoWidth, height: video.videoHeight });
        };
        video.addEventListener("loadedmetadata", restore); video.addEventListener("timeupdate", save); video.addEventListener("pause", save);
        if (video.readyState >= 1) restore();
        const unregister = register(video, setVisible, save);
        return () => {
            save(); unregister(); video.removeEventListener("loadedmetadata", restore); video.removeEventListener("timeupdate", save); video.removeEventListener("pause", save);
        };
    }, [src]);
    useEffect(() => {
        const video = ref.current;
        if (!video) return;
        if (!active) video.pause();
        else if (visible && video.paused && video.readyState >= 1) {
            const time = knownMedia(src)?.time;
            if (time !== undefined && Number.isFinite(video.duration)) video.currentTime = Math.min(time, Math.max(0, video.duration - .05));
        }
    }, [active, visible, src]);
    return { ref, visible };
}
