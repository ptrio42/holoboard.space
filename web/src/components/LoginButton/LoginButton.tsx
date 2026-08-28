import { useState } from "react";
import { NDKNip07Signer } from "@nostr-dev-kit/ndk";
import {
    useCurrentUserProfile,
    useNDKCurrentUser,
    useNDKSessionLogin,
    useNDKSessionLogout,
} from "@nostr-dev-kit/react";
import { PixelButton } from "../ui/PixelButton";
import { Avatar } from "../ui/Avatar";
import { shortNpub } from "../../lib/nostr";

const NO_SIGNER =
    "No signer extension found. Install a NIP-07 extension such as Alby or nos2x, then reload.";

export function LoginButton() {
    const user = useNDKCurrentUser();
    const profile = useCurrentUserProfile();
    const login = useNDKSessionLogin();
    const logout = useNDKSessionLogout();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const signIn = async () => {
        setError(null);
        // Extensions inject late, so this has to be checked on click, not on mount.
        if (typeof window === "undefined" || !window.nostr) {
            setError(NO_SIGNER);
            return;
        }
        setBusy(true);
        try {
            const signer = new NDKNip07Signer();
            await signer.blockUntilReady();
            login(signer);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Sign-in was rejected.");
        } finally {
            setBusy(false);
        }
    };

    if (user) {
        const name = profile?.displayName || profile?.name || shortNpub(user.pubkey);
        return (
            <div className="flex items-center gap-2">
                <span className="flex items-center gap-2 border-2 border-cyan-400/30 px-2 py-1.5">
                    <Avatar pubkey={user.pubkey} src={profile?.picture} name={name} size={22} />
                    <span className="max-w-[9rem] truncate font-pixel text-[9px] text-cyan-200">
                        {name}
                    </span>
                </span>
                <PixelButton variant="ghost" size="sm" onClick={() => logout()}>
                    Log out
                </PixelButton>
            </div>
        );
    }

    return (
        <div className="flex flex-col items-end gap-2">
            <PixelButton size="sm" onClick={signIn} disabled={busy}>
                {busy ? "Waiting..." : "Connect signer"}
            </PixelButton>
            {error && (
                <p role="alert" className="max-w-xs text-right text-[11px] leading-snug text-neon-pink">
                    {error}
                </p>
            )}
        </div>
    );
}
