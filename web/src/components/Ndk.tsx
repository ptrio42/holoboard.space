// components/Ndk.tsx
'use client';

import { useNDKInit } from "@nostr-dev-kit/react";
import { useEffect } from "react";
import { ndk } from "../lib/ndk";

/**
 * Initialises NDK once, away from the tree, so pool and session changes do not
 * re-render the app.
 *
 * Reading the board and paying to promote need no signer or account session.
 */
export default function NDKHeadless() {
    const initNDK = useNDKInit();

    useEffect(() => {
        if (ndk) initNDK(ndk);
    }, [initNDK])

    return null;
}
