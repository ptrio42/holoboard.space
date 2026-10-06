import { useEffect, useRef, useState } from "react";
import { fetchWaitingUpdates, readWaitingVisit, saveWaitingVisit, waitingVisitKey, type WaitingUpdates } from "../lib/waitingUpdates";

export function useWaitingUpdates(waiting = false, successfulSnapshot?: number) {
    const baseline = useRef(readWaitingVisit());
    const [updates, setUpdates] = useState<WaitingUpdates>({ count: 0, noteIds: [], checkedAt: 0 });
    useEffect(() => {
        let controller: AbortController | undefined;
        const load = async () => {
            if (document.visibilityState !== "visible") return;
            controller?.abort();
            const request = new AbortController(); controller = request;
            const since = waiting ? baseline.current : readWaitingVisit();
            try {
                const result = await fetchWaitingUpdates(since, request.signal);
                if (request.signal.aborted) return;
                setUpdates(result);
                if (since === null) {
                    baseline.current = result.checkedAt;
                    saveWaitingVisit(result.checkedAt);
                }
            } catch { /* A failed check keeps the previous badge and visit checkpoint. */ }
        };
        void load();
        const timer = window.setInterval(() => void load(), 15000);
        const onStorage = (event: StorageEvent) => { if (event.key === waitingVisitKey && !waiting) void load(); };
        document.addEventListener("visibilitychange", load);
        window.addEventListener("storage", onStorage);
        return () => { controller?.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", load); window.removeEventListener("storage", onStorage); };
    }, [waiting]);
    useEffect(() => {
        if (!waiting || !successfulSnapshot || !updates.checkedAt) return;
        const acknowledge = () => {
            if (document.visibilityState === "visible") saveWaitingVisit(Math.min(successfulSnapshot, updates.checkedAt));
        };
        acknowledge();
        document.addEventListener("visibilitychange", acknowledge);
        return () => document.removeEventListener("visibilitychange", acknowledge);
    }, [waiting, successfulSnapshot, updates.checkedAt]);
    return updates;
}
