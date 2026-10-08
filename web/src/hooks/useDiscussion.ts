import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { discussionCoordinator, type DiscussionHandle, type DiscussionSnapshot } from "../lib/discussionReads";

export function useDiscussion(focusId: string, author?: string) {
    const [snapshot, setSnapshot] = useState<DiscussionSnapshot | null>(null);
    const [error, setError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const handle = useRef<DiscussionHandle | null>(null);
    const anchor = useRef<{ key: string; top: number; scroll: number } | null>(null);
    useEffect(() => {
        let active = true;
        let current: DiscussionHandle | undefined;
        // React's development effect replay must not reopen a closing session.
        queueMicrotask(() => {
            if (!active) return;
            const update = () => {
                if (!active || !current) return;
                if (window.scrollY > 0 && !anchor.current && !document.querySelector("[data-reading-restoring]")) {
                    const row = [...document.querySelectorAll<HTMLElement>("[data-discussion-key]")]
                        .find(element => element.getBoundingClientRect().bottom > 0 && element.getBoundingClientRect().top < window.innerHeight);
                    if (row) anchor.current = { key: row.dataset.discussionKey!, top: row.getBoundingClientRect().top, scroll: window.scrollY };
                }
                setSnapshot(current.snapshot());
            };
            try {
                current = discussionCoordinator.open({ focusId, author, onUpdate: update });
                handle.current = current;
                setError(false);
                update();
                void current.loadMore();
            } catch { setError(true); }
        });
        return () => {
            active = false; current?.close(); handle.current = null; anchor.current = null;
        };
    }, [focusId, author, attempt]);
    useLayoutEffect(() => {
        const previous = anchor.current;
        anchor.current = null;
        if (!previous || document.querySelector("[data-reading-restoring]") || Math.abs(window.scrollY - previous.scroll) > 2) return;
        const row = [...document.querySelectorAll<HTMLElement>("[data-discussion-key]")]
            .find(element => element.dataset.discussionKey === previous.key);
        if (row) window.scrollBy(0, row.getBoundingClientRect().top - previous.top);
    }, [snapshot]);
    return { snapshot, error, loadMore: () => void handle.current?.loadMore(), retry: () => setAttempt(value => value + 1) };
}
