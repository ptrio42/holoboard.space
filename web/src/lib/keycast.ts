import type { Event, EventTemplate } from "nostr-tools/pure";
import { ENABLE_EMAIL_ACCOUNTS, KEYCAST_CLIENT_ID, KEYCAST_URL } from "../config";
import { connectKeycastSigner, disconnectSigner, getConnections } from "./connections";

// Protocol adapter pinned to Keycast fe9c6460c89e82e22c3aab4ba1dc79b7f0dd54c0.
// OAuth state validation belongs to Holoboard, alongside the PKCE transaction.
const SESSION = "holoboard-keycast-session";
interface Session { accessToken: string; bunkerPubkey: string; pubkey?: string; expiresAt: number }
const callback = () => `${location.origin}/account/callback`;
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function keycastOrigin() {
    const url = new URL(KEYCAST_URL);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("The account service URL is not configured securely.");
    return url.origin;
}

async function request(path: string, body: unknown, accessToken?: string) {
    const response = await fetch(`${keycastOrigin()}${path}`, { method: "POST", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(20000),
        headers: { "Content-Type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error("The account request failed. Retry or manage your account at the sign-in service.");
    return await response.json() as Record<string, unknown>;
}

async function attach(session: Session) {
    if (session.expiresAt <= Date.now() || !/^[0-9a-f]{64}$/.test(session.bunkerPubkey)) throw new Error("Your account session expired. Sign in again.");
    const rpc = async (method: string, params: unknown[] = []) => {
        if (session.expiresAt <= Date.now()) throw new Error("Your account session expired. Sign in again; your draft is preserved.");
        const response = await request("/api/nostr", { method, params }, session.accessToken);
        if (response.error || response.result === undefined) throw new Error("The account did not approve the signing request.");
        return response.result;
    };
    await connectKeycastSigner({ getPublicKey: async () => await rpc("get_public_key") as string,
        signEvent: async (template: EventTemplate) => await rpc("sign_event", [{ ...template, pubkey: getConnections().signerPubkey }]) as Event }, session.pubkey);
    session.pubkey = getConnections().signerPubkey;
    sessionStorage.setItem(SESSION, JSON.stringify(session));
}

/** A popup keeps the live editor, guest key and every payment choice in place. */
export async function signInWithEmail(register = false) {
    if (!ENABLE_EMAIL_ACCOUNTS) throw new Error("Email accounts are disabled.");
    const origin = keycastOrigin();
    const popup = window.open("about:blank", "holoboard-account", "popup,width=520,height=760");
    if (!popup) throw new Error("Allow the sign-in window, then try again. Your draft is preserved.");
    const state = crypto.randomUUID();
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    try {
        const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
        const url = new URL(`${origin}/api/oauth/authorize`);
        for (const [name, value] of Object.entries({ client_id: KEYCAST_CLIENT_ID, redirect_uri: callback(), scope: "policy:holoboard", code_challenge: challenge, code_challenge_method: "S256", state, ...(register ? { default_register: "true" } : {}) })) url.searchParams.set(name, value);
        const result = waitForPopup(popup, location.origin, "holoboard-oauth", state);
        popup.location.replace(url.toString());
        const code = await result;
        if (!code) throw new Error("Sign-in was not completed. Your draft is preserved.");
        const data = await request("/api/oauth/token", { grant_type: "authorization_code", code, client_id: KEYCAST_CLIENT_ID, redirect_uri: callback(), code_verifier: verifier });
        if (typeof data.access_token !== "string" || typeof data.bunker_url !== "string" || typeof data.expires_in !== "number" || data.expires_in <= 0) throw new Error("The account service returned an incomplete session.");
        const bunker = new URL(data.bunker_url);
        if (bunker.protocol !== "bunker:") throw new Error("Invalid account session.");
        await attach({ accessToken: data.access_token, bunkerPubkey: bunker.hostname, expiresAt: Date.now() + data.expires_in * 1000 });
    } finally { popup.close(); }
}

function waitForPopup(popup: Window, origin: string, type: string, state: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const finish = (error?: Error, value = "") => { window.removeEventListener("message", message); clearInterval(timer); if (error) reject(error); else resolve(value); };
        const message = (event: MessageEvent) => {
            if (event.source !== popup || event.origin !== origin || event.data?.type !== type || event.data?.state !== state) return;
            if (event.data.error) finish(new Error("The account request was not completed. Your draft is preserved."));
            else finish(undefined, typeof event.data.code === "string" ? event.data.code : "");
        };
        window.addEventListener("message", message);
        const started = Date.now();
        const timer = setInterval(() => { if (popup.closed || Date.now() - started > 15 * 60 * 1000) finish(new Error("The sign-in window closed or expired. Your draft is preserved.")); }, 500);
    });
}

/** Served on our isolated Keycast origin, using its first-party session cookie.
 * OAuth signing tokens cannot manage authorizations in this pinned version. */
export async function signOutEmailAccount() {
    const session = JSON.parse(sessionStorage.getItem(SESSION) ?? "null") as Session | null;
    if (!session) { disconnectSigner(); return; }
    const state = crypto.randomUUID();
    const url = new URL(`${keycastOrigin()}/holoboard-session.html`);
    url.hash = new URLSearchParams({ bunker: session.bunkerPubkey, origin: location.origin, state }).toString();
    const popup = window.open("about:blank", "holoboard-account", "popup,width=520,height=760");
    if (!popup) throw new Error("Allow the account window to revoke this session.");
    try {
        const result = waitForPopup(popup, keycastOrigin(), "holoboard-logout", state);
        popup.location.replace(url.toString());
        await result;
        disconnectSigner();
    } finally { popup.close(); }
}

export async function restoreKeycastAccount() {
    if (!ENABLE_EMAIL_ACCOUNTS) return;
    try {
        const session = JSON.parse(sessionStorage.getItem(SESSION) ?? "null") as Session | null;
        if (session && typeof session.accessToken === "string") await attach(session);
    } catch { sessionStorage.removeItem(SESSION); }
}
