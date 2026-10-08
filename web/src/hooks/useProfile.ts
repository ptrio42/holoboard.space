import { useEffect, useMemo, useState } from "react";
import type { SafeProfile } from "../lib/nostrReads";
import { cachedProfileValue, profileReader, type ProfileHandle } from "../lib/profileReads";

export function useProfileValue(pubkey?: string, hints: string[] = []): SafeProfile | undefined {
    const [value, setValue] = useState<{ pubkey: string; profile?: SafeProfile }>();
    const cached = useMemo(() => pubkey ? cachedProfileValue(pubkey) : undefined, [pubkey]);
    const relayKey = JSON.stringify(hints);
    useEffect(() => {
        if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) return;
        let active = true;
        let pending: ProfileHandle | undefined;
        const refresh = () => {
            if (pending) return;
            const stored = cachedProfileValue(pubkey);
            if (stored) {
                queueMicrotask(() => { if (active) setValue({ pubkey, profile: stored }); });
                return;
            }
            try {
                const handle = profileReader.open(pubkey, JSON.parse(relayKey) as string[], () => {
                    const snapshot = handle.snapshot();
                    if (active && snapshot.event) setValue({ pubkey, profile: snapshot.profile });
                });
                pending = handle;
                // Show verified metadata while other relays are still pending.
                void handle.refresh().finally(() => {
                    if (active) setValue({ pubkey, profile: handle.snapshot().profile });
                    handle.close();
                    if (pending === handle) pending = undefined;
                }).catch(() => {});
            } catch { /* A later refresh can retry bounded read admission. */ }
        };
        refresh();
        const timer = setInterval(refresh, 30_000);
        return () => { active = false; clearInterval(timer); pending?.close(); };
    }, [pubkey, relayKey]);
    return value?.pubkey === pubkey ? value?.profile : cached;
}
