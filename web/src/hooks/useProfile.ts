import { useEffect, useState } from "react";
import { readProfile, type SafeProfile } from "../lib/nostrReads";

export function useProfileValue(pubkey?: string, hints: string[] = []): SafeProfile | undefined {
    const [value, setValue] = useState<{ pubkey: string; profile?: SafeProfile }>();
    const relayKey = JSON.stringify(hints);
    useEffect(() => {
        if (!pubkey) return;
        let active = true;
        const refresh = () => void readProfile(pubkey, JSON.parse(relayKey) as string[]).then((profile) => { if (active) setValue({ pubkey, profile }); }).catch(() => {});
        refresh();
        const timer = setInterval(refresh, 30_000);
        return () => { active = false; clearInterval(timer); };
    }, [pubkey, relayKey]);
    return value?.pubkey === pubkey ? value?.profile : undefined;
}
