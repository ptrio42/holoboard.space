import { useEffect, useRef, useState } from "react";
import { ProfilePromotions, type ProfilePromotionsSnapshot } from "../lib/profilePromotions";

export function useProfilePromotions(pubkey: string) {
    const [snapshot, setSnapshot] = useState<ProfilePromotionsSnapshot | null>(null);
    const handle = useRef<ProfilePromotions | null>(null);
    useEffect(() => {
        let active = true, current: ProfilePromotions | undefined;
        queueMicrotask(() => {
            if (!active) return;
            current = new ProfilePromotions(pubkey, () => { if (active && current) setSnapshot(current.snapshot()); });
            handle.current = current; setSnapshot(current.snapshot());
            void current.loadMore().then(() => {
                // Check TOP 21 and one waiting-room page automatically. Later
                // pages require a deliberate action from the reader.
                if (active && !current!.snapshot().error) void current!.loadMore();
            });
        });
        return () => { active = false; current?.close(); handle.current = null; };
    }, [pubkey]);
    return { snapshot, loadMore: () => void handle.current?.loadMore() };
}
