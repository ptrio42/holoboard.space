import { useEffect, useRef, useState } from "react";
import { profileReader, type ProfileHandle, type ProfileSnapshot } from "../lib/profileReads";

export function useProfileRead(pubkey: string, hints: string[]) {
    const [snapshot, setSnapshot] = useState<ProfileSnapshot | null>(null);
    const [error, setError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const handle = useRef<ProfileHandle | null>(null);
    const hintKey = JSON.stringify(hints);
    useEffect(() => {
        let active = true, current: ProfileHandle | undefined;
        queueMicrotask(() => {
            if (!active) return;
            try {
                current = profileReader.open(pubkey, JSON.parse(hintKey), () => { if (active && current) setSnapshot(current.snapshot()); });
                handle.current = current; setSnapshot(current.snapshot()); setError(false);
                void current.refresh();
            } catch { setError(true); }
        });
        return () => { active = false; current?.close(); handle.current = null; };
    }, [pubkey, hintKey, attempt]);
    return { snapshot, error, refresh: () => error ? setAttempt(value => value + 1) : void handle.current?.refresh() };
}
