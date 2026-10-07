import { useCallback, useEffect, useRef, useState } from "react";
import { monitorRelay } from "../lib/nostrTransport";

export type RelayStatus = "connecting" | "connected" | "offline";

export function useRelayStatus(url: string): { status: RelayStatus; retry: () => void } {
    const [status, setStatus] = useState<RelayStatus>("connecting");
    const retryRef = useRef<() => void>(() => {});
    const retry = useCallback(() => retryRef.current(), []);
    useEffect(() => {
        const monitor = monitorRelay(url, setStatus);
        retryRef.current = monitor.retry;
        return () => { retryRef.current = () => {}; monitor.close(); };
    }, [url]);
    return { status, retry };
}
