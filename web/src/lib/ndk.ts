import NDK from "@nostr-dev-kit/ndk";
import NDKCacheAdapterDexie from "@nostr-dev-kit/cache-dexie";
import { PUBLIC_RELAYS, RELAY_URL } from "../config";

/*
 * The board relay and the public relays serve different jobs and both have to
 * be in the pool. The board relay only ever returns notes that were paid for,
 * so profiles, the promotion mention, the relay's reply to it and the zap
 * receipt all have to travel over public relays. Board queries pin themselves
 * to RELAY_URL so none of that leaks into the ranking.
 */
const explicitRelayUrls = [RELAY_URL, ...PUBLIC_RELAYS];

// An optional in-browser cache adapter (client-side only)
let cacheAdapter: NDKCacheAdapterDexie | undefined;
if (typeof window !== "undefined") {
    cacheAdapter = new NDKCacheAdapterDexie({ dbName: "holoboard" });
}

/** The singleton NDK instance for the whole app. */
export const ndk = new NDK({ explicitRelayUrls, cacheAdapter });

// Connect to relays on initialization (client-side)
if (typeof window !== "undefined") ndk.connect();
