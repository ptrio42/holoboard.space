import { useState } from "react";
import { KEYCAST_URL } from "../../config";
import { useConnections } from "../../hooks/useConnections";
import { signInWithEmail, signOutEmailAccount } from "../../lib/keycast";
import { PixelButton } from "../ui/PixelButton";
import { StatusMessage } from "../ui/StatusMessage";

export function EmailAccount({ disabled }: { disabled?: boolean }) {
    const connections = useConnections();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const run = async (action: () => Promise<void>) => { setBusy(true); setError(""); try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Account request failed."); } finally { setBusy(false); } };
    return <section aria-label="Email account" className="space-y-3">
        {connections.signerKind === "keycast" && connections.signerStatus === "connected" ? <>
            <p className="text-xs">Your account key is held by Holoboard's sign-in service.</p>
            <a className="promotion-action focus-pixel inline-flex min-h-11 items-center text-neon-cyan" href={`${KEYCAST_URL}/settings/security`} target="_blank" rel="noopener noreferrer">Account security / export key</a>
            <a className="promotion-action focus-pixel inline-flex min-h-11 items-center text-neon-cyan" href={KEYCAST_URL} target="_blank" rel="noopener noreferrer">Manage sessions</a>
            <PixelButton size="sm" variant="ghost" disabled={disabled || busy} onClick={() => void run(signOutEmailAccount)}>Sign out and revoke session</PixelButton>
        </> : <>
            <div className="flex flex-wrap gap-3"><PixelButton size="sm" disabled={disabled || busy || !KEYCAST_URL} onClick={() => void run(() => signInWithEmail())}>Sign in with email</PixelButton><PixelButton size="sm" variant="ghost" disabled={disabled || busy || !KEYCAST_URL} onClick={() => void run(() => signInWithEmail(true))}>Create account</PixelButton></div>
            <p className="text-xs text-cyan-100/65">Use an email and password. Holoboard's sign-in service holds your author key; you can export it later. Password recovery and email verification open in the sign-in window.</p>
        </>}
        {busy && <StatusMessage compact loading>Complete the account request in the sign-in window...</StatusMessage>}
        {error && <p role="alert" className="text-xs text-neon-pink">{error}</p>}
    </section>;
}
