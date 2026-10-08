import { useEffect, useState } from "react";
import { verifyNip05, type Nip05Result, type Nip05State } from "../lib/nip05Verification";

export function useNip05Verification(pubkey: string, identifier?: string) {
    const [attempt, setAttempt] = useState(0);
    const [result, setResult] = useState<{ key: string; attempt: number; value: Nip05Result } | null>(null);
    const key = JSON.stringify([pubkey, identifier]);
    useEffect(() => {
        if (!identifier) return;
        const controller = new AbortController();
        let active = true;
        queueMicrotask(() => {
            if (!active) return;
            void verifyNip05(pubkey, identifier, controller.signal).then(value => {
                if (active) setResult({ key, attempt, value });
            }).catch(() => { /* Closing or replacing this profile cancels its check. */ });
        });
        return () => { active = false; controller.abort("profile closed"); };
    }, [pubkey, identifier, key, attempt]);
    const current = result?.key === key && result.attempt === attempt ? result.value : undefined;
    const state: Nip05State | "checking" | undefined = identifier ? current?.state ?? "checking" : undefined;
    return { state, checkedAt: current?.checkedAt, retry: () => setAttempt(value => value + 1) };
}
