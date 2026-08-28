import { useEffect, useState } from "react";
import { fetchLedger, toSatsMap, type SatsMap } from "../lib/sats";

const REFRESH_MS = 15_000;

const EMPTY: SatsMap = new Map();

interface SatsState {
    /** Event id to sats paid. Missing means "not known yet", not "zero". */
    sats: SatsMap;
    /** Everything the board has taken, or null before the first answer. */
    totalSats: number | null;
}

/**
 * Polls the relay's payment ledger.
 *
 * The board itself is live over a websocket, but the sats totals are not: they
 * cannot ride along on the signed notes, so they come over HTTP and have to be
 * asked for again. Nothing pushes, so this polls, and refreshes on the way back
 * to a tab that was left open, since an interval in a background tab is
 * throttled to the point of being wrong.
 *
 * A failed fetch keeps the last good numbers rather than blanking the board.
 * Sats missing for a moment is a smaller lie than sats claiming to be zero.
 */
export function useSatsMap(endpoint: string): SatsState {
    const [state, setState] = useState<SatsState>({ sats: EMPTY, totalSats: null });

    useEffect(() => {
        let cancelled = false;
        let controller: AbortController | null = null;

        const load = async () => {
            controller?.abort();
            controller = new AbortController();

            try {
                const ledger = await fetchLedger(endpoint, controller.signal);
                if (cancelled) return;
                setState({ sats: toSatsMap(ledger), totalSats: ledger.totalSats });
            } catch {
                // Keep whatever was already on screen.
            }
        };

        void load();
        const timer = window.setInterval(() => void load(), REFRESH_MS);

        const onVisible = () => {
            if (document.visibilityState === "visible") void load();
        };
        document.addEventListener("visibilitychange", onVisible);

        return () => {
            cancelled = true;
            controller?.abort();
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [endpoint]);

    return state;
}
