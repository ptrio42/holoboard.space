// components/ndk.tsx
'use client';

// Here we will initialize NDK and configure it to be available throughout the application
import NDK, { NDKNip07Signer, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

// An optional in-browser cache adapter
import NDKCacheAdapterDexie from "@nostr-dev-kit/cache-dexie";
import { NDKSessionLocalStorage, useNDKInit, useNDKSessionMonitor } from "@nostr-dev-kit/react";
import { useEffect } from "react";

// Define explicit relays or use defaults
const explicitRelayUrls = ["wss://relay.holoboard.space"];

// Setup Dexie cache adapter (Client-side only)
let cacheAdapter: NDKCacheAdapterDexie | undefined;
if (typeof window !== "undefined") {
    cacheAdapter = new NDKCacheAdapterDexie({ dbName: "holoboard" });
}

// Create the singleton NDK instance
const ndk = new NDK({ explicitRelayUrls, cacheAdapter });

// Connect to relays on initialization (client-side)
if (typeof window !== "undefined") ndk.connect();

// Use the browser's localStorage for session storage
const sessionStorage = new NDKSessionLocalStorage();

/**
 * Use an NDKHeadless component to initialize NDK in order to prevent application-rerenders
 * when there are changes to the NDK or session state.
 *
 * Include this headless component in your app layout to initialize NDK correctly.
 * @returns
 */
export default function NDKHeadless() {
    const initNDK = useNDKInit();

    useNDKSessionMonitor(sessionStorage, {
        profile: true, // automatically fetch profile information for the active user
        follows: true, // automatically fetch follows of the active user
    });

    useEffect(() => {
        if (ndk) initNDK(ndk);
    }, [initNDK])

    return null;
}