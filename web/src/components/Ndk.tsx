// components/Ndk.tsx
'use client';

import { useNDKInit } from "@nostr-dev-kit/react";
import { useEffect } from "react";
import { ndk } from "../lib/ndk";

/**
 * Initialises NDK once, away from the tree, so pool and session changes do not
 * re-render the app.
 *
 * Nothing here goes looking for a signer. There used to be a session monitor
 * restoring whatever was in localStorage, and for a NIP-07 session that means
 * building the signer again, which makes the extension pop up asking to share a
 * pubkey the moment anybody opens the page. Reading the board needs no key and
 * neither does paying to promote, so being asked to identify yourself on
 * arrival was the site demanding something it never uses.
 *
 * The one route that does want a signer builds it on a click, in LoginButton.
 * The cost is that a signed-in session no longer survives a reload, which is a
 * fair price for not greeting every visitor with a permission prompt.
 */
export default function NDKHeadless() {
    const initNDK = useNDKInit();

    useEffect(() => {
        if (ndk) initNDK(ndk);
    }, [initNDK])

    return null;
}
