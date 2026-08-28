import { useCallback, useEffect, useRef, useState } from "react";
import { NDKRelayStatus, type NDKRelay } from "@nostr-dev-kit/ndk";
import { useNDK } from "@nostr-dev-kit/react";

export type RelayStatus = "connecting" | "connected" | "offline";

const RETRY_INTERVAL_MS = 15_000;

/**
 * Tracks one relay's connection so the board can say "the relay is down"
 * instead of showing an empty page that looks like an empty board.
 *
 * NDK gives up on a relay it could never reach, which on this app means a
 * visitor who arrives during a blip is stuck on a dead page until they reload.
 * So this also keeps knocking, and hands back a `retry` for the button.
 */
export function useRelayStatus(url: string): { status: RelayStatus; retry: () => void } {
    const { ndk } = useNDK();
    const [status, setStatus] = useState<RelayStatus>("connecting");
    const relayRef = useRef<NDKRelay | null>(null);

    const retry = useCallback(() => {
        setStatus("connecting");
        void relayRef.current?.connect(4_000, true).catch(() => setStatus("offline"));
    }, []);

    useEffect(() => {
        if (!ndk) return;

        const normalised = url.replace(/\/$/, "");

        const read = () => {
            for (const [relayUrl, relay] of ndk.pool.relays) {
                if (relayUrl.replace(/\/$/, "") !== normalised) continue;
                relayRef.current = relay;
                if (relay.status >= NDKRelayStatus.CONNECTED) return setStatus("connected");
                if (
                    relay.status === NDKRelayStatus.CONNECTING ||
                    relay.status === NDKRelayStatus.RECONNECTING
                ) {
                    return setStatus("connecting");
                }
                return setStatus("offline");
            }
            setStatus("connecting");
        };

        read();
        const events = [
            "relay:connect",
            "relay:ready",
            "relay:connecting",
            "relay:disconnect",
            "flapping",
        ] as const;
        for (const event of events) ndk.pool.on(event, read);

        // The pool does not always emit on the way down, so poll as a backstop.
        const poll = window.setInterval(read, 3_000);

        const knock = window.setInterval(() => {
            const relay = relayRef.current;
            if (relay && relay.status <= NDKRelayStatus.DISCONNECTED) {
                void relay.connect(4_000, true).catch(() => undefined);
            }
        }, RETRY_INTERVAL_MS);

        return () => {
            for (const event of events) ndk.pool.off(event, read);
            window.clearInterval(poll);
            window.clearInterval(knock);
        };
    }, [ndk, url]);

    return { status, retry };
}
