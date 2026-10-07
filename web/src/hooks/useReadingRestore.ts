import { useEffect, useLayoutEffect, useRef } from "react";

export function useReadingRestore(contentVersion: unknown) {
    const restore = useRef<number>(window.history.state?.readingScroll ?? 0);
    useEffect(() => {
        const cancel = () => { restore.current = 0; };
        const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
        for (const event of events) window.addEventListener(event, cancel, { passive: true });
        return () => { for (const event of events) window.removeEventListener(event, cancel); };
    }, []);
    useLayoutEffect(() => {
        if (restore.current > 0 && document.documentElement.scrollHeight >= restore.current + window.innerHeight) {
            window.scrollTo(0, restore.current); restore.current = 0;
        }
    }, [contentVersion]);
}
