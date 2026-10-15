import { useEffect, useRef, useState } from "react";
import { discussionCoordinator, type DiscussionHandle, type DiscussionSnapshot } from "../lib/discussionReads";

export function useDiscussion(focusId: string, author?: string, hints: string[] = []) {
    const [snapshot, setSnapshot] = useState<DiscussionSnapshot | null>(null);
    const [error, setError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const handle = useRef<DiscussionHandle | null>(null);
    const hintKey = JSON.stringify(hints);
    useEffect(() => {
        let active = true;
        let current: DiscussionHandle | undefined;
        // React's development effect replay must not reopen a closing session.
        queueMicrotask(() => {
            if (!active) return;
            const update = () => {
                if (!active || !current) return;
                setSnapshot(current.snapshot());
            };
            try {
                current = discussionCoordinator.open({ focusId, author, hints: JSON.parse(hintKey), onUpdate: update });
                handle.current = current;
                setError(false);
                update();
                void current.loadMore();
            } catch { setError(true); }
        });
        return () => {
            active = false; current?.close(); handle.current = null;
        };
    }, [focusId, author, hintKey, attempt]);
    return { snapshot, error, loadMore: () => void handle.current?.loadMore(), retry: () => setAttempt(value => value + 1) };
}
