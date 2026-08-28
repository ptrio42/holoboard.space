// components/Ndk.tsx
'use client';

import { NDKSessionLocalStorage, useNDKInit, useNDKSessionMonitor } from "@nostr-dev-kit/react";
import { useEffect } from "react";
import { ndk } from "../lib/ndk";

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
