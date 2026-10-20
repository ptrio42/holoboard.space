import { generateSecretKey, getPublicKey, type Event, type EventTemplate } from "nostr-tools/pure";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import type { BunkerSigner, BunkerPointer } from "nostr-tools/nip46";
import type { AbstractSimplePool } from "nostr-tools/abstract-pool";
import type { NWCClient } from "@getalby/sdk/nwc";
import { ENABLE_NOSTR_CONNECT, ENABLE_REPLY_PUBLICATION, ENABLE_POST_CREATION, PUBLIC_RELAYS } from "../config";
import { PaymentRejected, withTimeout, type PaymentWallet } from "./walletPayment";
import { attachWalletAccount, clearWalletAccount, refreshWalletAccount } from "./walletAccount";
import { lookupWalletPayment } from "./walletLookup";
import { verifiedNostrEvent } from "./verifyNostrEvent";
import { safeRelay } from "./relayPolicy";

export interface ConnectedSigner {
    getPublicKey(): Promise<string>;
    signEvent(template: EventTemplate): Promise<Event>;
}
type ConnectionStatus = "disconnected" | "connecting" | "connected";
export interface Connections {
    walletStatus: ConnectionStatus; walletName: string; walletError: string; walletCanRetry: boolean;
    signerStatus: ConnectionStatus; signerPubkey: string; signerKind: "extension" | "remote" | null;
    signerError: string; signerLink: string; signerAuthUrl: string;
    signerCanPost: boolean;
    signerCanReply: boolean;
    signerCanUpload: boolean;
}
let state: Connections = {
    walletStatus: "disconnected", walletName: "", walletError: "", walletCanRetry: false,
    signerStatus: "disconnected", signerPubkey: "", signerKind: null,
    signerError: "", signerLink: "", signerAuthUrl: "",
    signerCanPost: false,
    signerCanReply: false,
    signerCanUpload: false,
};
const listeners = new Set<() => void>();
export const subscribeConnections = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getConnections = () => state;
function update(patch: Partial<Connections>) { state = { ...state, ...patch }; listeners.forEach((listener) => listener()); }
const WALLET_KEY = "holoboard-nwc";
const SIGNER_KEY = "holoboard-signer";
let nwc: NWCClient | undefined;
let paymentWallet: PaymentWallet | undefined;
let signer: ConnectedSigner | undefined;
let remote: BunkerSigner | undefined;
let signerPool: AbstractSimplePool | undefined;
let signerAbort: AbortController | undefined;
let walletGeneration = 0;
let signerGeneration = 0;
let restored = false;
const HEX = /^[0-9a-f]{64}$/;

function read(key: string): string | null { try { return sessionStorage.getItem(key); } catch { return null; } }
export function hasSavedWalletConnection(): boolean {
    return state.walletStatus !== "disconnected" || !!read(WALLET_KEY);
}
function remember(key: string, value: string | null) {
    try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); } catch { /* Connections still work until this page is closed. */ }
}
export function validateRelay(value: string): string {
    const url = new URL(value);
    if (url.username || url.password || url.hash || (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
        throw new Error("Use a secure wss:// relay URL.");
    }
    return url.toString();
}
export function validateNwcUri(value: string): string {
    const uri = value.trim();
    if (!/^nostr\+?walletconnect:\/\//.test(uri)) throw new Error("Paste a Nostr Wallet Connect connection string from your wallet.");
    const url = new URL(uri);
    if (!HEX.test(url.hostname) || !HEX.test(url.searchParams.get("secret") ?? "") || !url.searchParams.getAll("relay").length || url.username || url.password || url.port || url.hash || (url.pathname !== "" && url.pathname !== "/")) {
        throw new Error("The NWC connection string is incomplete.");
    }
    url.searchParams.getAll("relay").forEach(validateRelay);
    return uri;
}
export function getPaymentWallet(): PaymentWallet | undefined {
    if (paymentWallet) return paymentWallet;
    const browser = (window as unknown as { webln?: { enable(): Promise<void>; sendPayment(invoice: string): Promise<{ preimage?: string }> } }).webln;
    return browser ? { id: "webln", kind: "webln", enable: () => browser.enable(), sendPayment: (invoice) => withTimeout(browser.sendPayment(invoice), 60000, "The wallet did not respond. Check its payment history before retrying.") } : undefined;
}
export function getConnectedSigner(): ConnectedSigner | undefined { return signer; }

export async function connectWallet(input: string) {
    disconnectWallet();
    const generation = walletGeneration;
    update({ walletStatus: "connecting", walletError: "" });
    let candidate: NWCClient | undefined;
    try {
        const uri = validateNwcUri(input);
        remember(WALLET_KEY, uri);
        update({ walletCanRetry: true });
        const { NWCClient, Nip47WalletError } = await import("@getalby/sdk/nwc");
        if (generation !== walletGeneration) return;
        candidate = new NWCClient({ nostrWalletConnectUrl: uri, requireSecret: true });
        const client = candidate;
        const info = await withTimeout(client.getInfo(), 15000, "Could not reach the wallet. Check its connection permissions and try again.");
        if (!Array.isArray(info.methods)) throw new Error("The wallet did not return its connection permissions.");
        if (info.network && info.network !== "mainnet") throw new Error("Connect a mainnet Lightning wallet.");
        if (generation !== walletGeneration) { client.close(); return; }
        nwc = client;
        paymentWallet = info.methods.includes("pay_invoice") ? {
            id: `nwc:${client.walletPubkey}:${client.publicKey}`, kind: "nwc", enable: async () => {},
            sendPayment: async (invoice, amountMsats) => {
                try {
                    const result = await withTimeout(client.payInvoice({ invoice, ...(amountMsats === undefined ? {} : { amount: amountMsats }) }), 60000, "The wallet did not confirm the payment. Its status is uncertain.");
                    void refreshWalletAccount();
                    return { preimage: result.preimage, feesPaidMsats: result.fees_paid };
                } catch (failure) {
                    if (failure instanceof Nip47WalletError && ["INSUFFICIENT_BALANCE", "QUOTA_EXCEEDED", "RESTRICTED", "UNAUTHORIZED", "NOT_IMPLEMENTED"].includes(failure.code)) {
                        throw new PaymentRejected(`The wallet declined this payment (${failure.code}).`);
                    }
                    throw new Error("The wallet did not confirm the payment. Check its history before retrying.");
                }
            },
            ...(info.methods.includes("lookup_invoice") ? { lookupPayment: (paymentHash: string) => lookupWalletPayment(client, paymentHash) } : {}),
        } : undefined;
        attachWalletAccount(client, info, paymentWallet, new URL(uri).searchParams.get("lud16") ?? "");
        update({ walletStatus: "connected", walletName: typeof info.alias === "string" && info.alias ? info.alias : "NWC wallet" });
    } catch (failure) {
        candidate?.close();
        if (generation !== walletGeneration) return;
        clearWalletAccount(); nwc = undefined; paymentWallet = undefined;
        update({ walletStatus: "disconnected", walletError: failure instanceof Error && !(failure as { code?: string }).code ? failure.message : "Could not connect the wallet. Check its permissions and try again." });
    }
}
export function disconnectWallet() {
    clearWalletAccount();
    walletGeneration++; nwc?.close(); nwc = undefined; paymentWallet = undefined;
    remember(WALLET_KEY, null);
    update({ walletStatus: "disconnected", walletName: "", walletError: "", walletCanRetry: false });
}
export function retryWalletConnection() { const uri = read(WALLET_KEY); if (uri) void connectWallet(uri); }

function extension(): ConnectedSigner | undefined { return (window as unknown as { nostr?: ConnectedSigner }).nostr; }
export function hasExtensionSigner(): boolean { return !!extension(); }
function authUrl(value: string, generation: number) {
    try { const url = new URL(value); if (url.protocol === "https:" && !url.username && !url.password && generation === signerGeneration) update({ signerAuthUrl: url.toString() }); } catch { /* Ignore malformed authentication links. */ }
}
class SignerTimeout extends Error {}
function waitForSigner<T>(request: Promise<T>, signal: AbortSignal, milliseconds: number, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const finish = (failure?: unknown, value?: T) => {
            clearTimeout(timer); signal.removeEventListener("abort", abort);
            if (failure !== undefined) reject(failure); else resolve(value as T);
        };
        const abort = () => finish(new Error("The connected signer changed. Review the account and try again."));
        const timer = setTimeout(() => finish(new SignerTimeout(message)), milliseconds);
        signal.addEventListener("abort", abort, { once: true });
        // Always attach both handlers, including for an already-aborted request.
        request.then(value => finish(undefined, value), failure => finish(failure ?? new Error("The signer declined the request.")));
        if (signal.aborted) abort();
    });
}
function bindSigner(candidate: ConnectedSigner, pubkey: string): ConnectedSigner {
    if (!HEX.test(pubkey)) throw new Error("The signer returned an invalid public key.");
    const generation = signerGeneration;
    const signal = signerAbort!.signal;
    let pending = false, signedRequests = 0;
    const requireCurrent = () => {
        if (generation !== signerGeneration) throw new Error("The connected signer changed. Review the account and try again.");
    };
    return {
        getPublicKey: async () => { requireCurrent(); return pubkey; },
        signEvent: async (template) => {
            requireCurrent();
            if (state.signerKind === "remote" && ((template.kind === 1 && !state.signerCanReply && !state.signerCanPost) || (template.kind === 1111 && !state.signerCanReply))) throw new Error("Reconnect your signer to approve reply permissions. Your draft is preserved.");
            if (state.signerKind === "remote" && [24242, 27235].includes(template.kind) && !state.signerCanUpload) throw new Error("Reconnect your signer to approve file upload permissions. Your draft is preserved.");
            if (pending) throw new Error("A signer request is already waiting for approval.");
            // nostr-tools 2.25.2 retains auth-request bookkeeping after replies.
            // Bound a remote session until the dependency exposes request cleanup.
            if (state.signerKind === "remote" && signedRequests >= 64) {
                disconnectSigner();
                throw new Error("Reconnect your signer to start a fresh signing session. Your draft is preserved.");
            }
            pending = true; signedRequests++;
            try {
                // Keep the validation snapshot private. Extensions can mutate
                // objects passed to them, and callers can edit their own draft.
                const expected: EventTemplate = { kind: template.kind, created_at: template.created_at, content: template.content, tags: template.tags.map(tag => [...tag]) };
                const input: EventTemplate = { ...expected, tags: expected.tags.map(tag => [...tag]) };
                const result = await waitForSigner(candidate.signEvent(input), signal, 120000, "The signer did not respond. Return to Holoboard after approving the request, or try again.");
                requireCurrent();
                const event = verifiedNostrEvent(result);
                if (!event || event.pubkey !== pubkey || event.kind !== expected.kind || event.content !== expected.content || event.created_at !== expected.created_at || JSON.stringify(event.tags) !== JSON.stringify(expected.tags)) {
                    throw new Error("The signer changed the requested event or account.");
                }
                return event;
            } catch (failure) {
                // The library cannot cancel an individual RPC. Retire its pool
                // after a timeout so retries cannot accumulate pending requests.
                if (failure instanceof SignerTimeout && generation === signerGeneration && state.signerKind === "remote") disconnectSigner();
                throw failure;
            } finally {
                pending = false;
                if (generation === signerGeneration) update({ signerAuthUrl: "" });
            }
        },
    };
}
export async function connectExtension() {
    disconnectSigner();
    const generation = signerGeneration;
    const controller = new AbortController(); signerAbort = controller;
    update({ signerStatus: "connecting", signerKind: "extension" });
    try {
        const candidate = extension();
        if (!candidate) throw new Error("No Nostr browser extension was found. Use Amber or a remote signer instead.");
        const pubkey = await waitForSigner(candidate.getPublicKey(), controller.signal, 30000, "The extension did not respond. Try connecting again.");
        if (generation !== signerGeneration) return;
        signer = bindSigner(candidate, pubkey);
        remember(SIGNER_KEY, JSON.stringify({ kind: "extension", pubkey }));
        update({ signerStatus: "connected", signerPubkey: pubkey, signerCanPost: true, signerCanReply: true, signerCanUpload: true });
    } catch (failure) { if (generation === signerGeneration) update({ signerStatus: "disconnected", signerError: failure instanceof Error ? failure.message : "The signer declined the connection." }); }
}
interface RemoteSession { kind: "remote"; clientKey: string; pointer: BunkerPointer; pubkey: string; replyPermissions?: boolean; mediaPermissions?: boolean; postPermissions?: boolean }
function signerWebSocket(): typeof WebSocket {
    // nostr-tools queues CLOSE frames in a microtask while destroy() closes the socket immediately.
    // A closed socket already removes its subscriptions, so that cleanup frame is unnecessary.
    return class extends WebSocket {
        override send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
            if (this.readyState !== WebSocket.OPEN && typeof data === "string" && data.startsWith('["CLOSE",')) return;
            super.send(data);
        }
    };
}
async function finishRemote(candidate: BunkerSigner, clientKey: Uint8Array, generation: number, signal: AbortSignal, create: (pointer: BunkerPointer) => BunkerSigner, replyPermissions: boolean, mediaPermissions: boolean, postPermissions: boolean, expectedPubkey?: string) {
    const pubkey = await waitForSigner(candidate.getPublicKey(), signal, 20000, "The signer did not return an account. Try connecting again.");
    if (generation !== signerGeneration) { await candidate.close(); return; }
    if (expectedPubkey && expectedPubkey !== pubkey) throw new Error("The connected signer changed account. Connect again to choose the new account.");
    // Read the RPC result ourselves: the installed switchRelays() mutates its
    // pointer and opens subscriptions before an application can validate URLs.
    try {
        const response = await waitForSigner(candidate.sendRequest("switch_relays", []), signal, 5000, "Signer relay update timed out.");
        if (generation !== signerGeneration) return;
        const values: unknown = JSON.parse(response);
        if (Array.isArray(values) && values.length > 0 && values.length <= 4 && values.every(value => typeof value === "string" && !!safeRelay(value))) {
            const relays = [...new Set(values.map(value => validateRelay(value)))];
            if (JSON.stringify([...relays].sort()) !== JSON.stringify(candidate.bp.relays.map(validateRelay).sort())) {
                const old = candidate;
                await old.close();
                candidate = create({ ...old.bp, relays, secret: null }); remote = candidate;
            }
        }
    } catch { /* Older signers may not implement switch_relays. Keep the approved relays. */ }
    if (generation !== signerGeneration) { await candidate.close(); return; }
    signer = bindSigner(candidate, pubkey); remote = candidate;
    const session: RemoteSession = { kind: "remote", clientKey: bytesToHex(clientKey), pointer: { ...candidate.bp, secret: null }, pubkey, replyPermissions, mediaPermissions, postPermissions };
    remember(SIGNER_KEY, JSON.stringify(session));
    update({ signerStatus: "connected", signerKind: "remote", signerPubkey: pubkey, signerLink: "", signerAuthUrl: "", signerCanPost: postPermissions, signerCanReply: replyPermissions, signerCanUpload: mediaPermissions });
}
export async function connectRemote(input?: string, saved?: RemoteSession) {
    disconnectSigner();
    const generation = signerGeneration;
    const controller = new AbortController(); signerAbort = controller;
    update({ signerStatus: "connecting", signerKind: "remote" });
    let candidate: BunkerSigner | undefined;
    try {
        const [{ BunkerSigner, parseBunkerInput, createNostrConnectURI }, { SignerPool }] = await Promise.all([import("nostr-tools/nip46"), import("./signerPool")]);
        if (generation !== signerGeneration) return;
        const pool = new SignerPool({ verifyEvent: event => !!verifiedNostrEvent(event), websocketImplementation: signerWebSocket(), maxWaitForConnection: 10000,
            allowConnectingToRelay: url => { try { validateRelay(url); return generation === signerGeneration; } catch { return false; } } }); signerPool = pool;
        const key = saved ? hexToBytes(saved.clientKey) : generateSecretKey();
        const replyPermissions = saved ? saved.replyPermissions === true : ENABLE_REPLY_PUBLICATION;
        const mediaPermissions = saved ? saved.mediaPermissions === true : ENABLE_REPLY_PUBLICATION;
        const postPermissions = saved ? saved.postPermissions === true : ENABLE_POST_CREATION;
        const permissions = [...(postPermissions && !replyPermissions ? ["sign_event:1"] : []), "sign_event:9734", ...(replyPermissions ? ["sign_event:1", "sign_event:1111"] : []), ...(mediaPermissions ? ["sign_event:24242", "sign_event:27235"] : [])];
        const params = { pool, skipSwitchRelays: true, onauth: (url: string) => authUrl(url, generation) };
        if (input || saved) {
            if (input && !input.trim().startsWith("bunker://")) throw new Error("Paste a bunker:// connection string from your signer.");
            const pointer = saved?.pointer ?? await parseBunkerInput(input!.trim());
            if (generation !== signerGeneration) return;
            if (!pointer || !HEX.test(pointer.pubkey) || !pointer.relays.length || pointer.relays.length > 4) throw new Error("The signer connection string is incomplete or has too many relays.");
            pointer.relays.forEach(validateRelay);
            candidate = BunkerSigner.fromBunker(key, pointer, params); remote = candidate;
            if (!saved) await waitForSigner(candidate.sendRequest("connect", [pointer.pubkey, pointer.secret ?? "", permissions.join(","), JSON.stringify({ name: "Holoboard", url: window.location.origin })]), controller.signal, 60000, "The signer did not approve the connection. Try again.");
        } else {
            const relays = PUBLIC_RELAYS.slice(0, 2).map(validateRelay);
            const uri = createNostrConnectURI({ clientPubkey: getPublicKey(key), relays, secret: bytesToHex(generateSecretKey()), perms: permissions, name: "Holoboard", url: window.location.origin });
            update({ signerLink: uri });
            const timer = setTimeout(() => controller.abort(), 180000);
            try { candidate = await BunkerSigner.fromURI(key, uri, params, controller.signal); }
            finally { clearTimeout(timer); }
        }
        await finishRemote(candidate, key, generation, controller.signal, pointer => BunkerSigner.fromBunker(key, pointer, params), replyPermissions, mediaPermissions, postPermissions, saved?.pubkey);
    } catch {
        await candidate?.close();
        if (generation !== signerGeneration) return;
        signerPool?.destroy(); signerPool = undefined; remote = undefined; signer = undefined;
        update({ signerStatus: "disconnected", signerLink: "", signerAuthUrl: "", signerError: "Could not connect the signer. Check its approval and relay settings, then try again." });
    }
}
export function disconnectSigner() {
    signerGeneration++; signerAbort?.abort(); signerAbort = undefined;
    const previous = remote; remote = undefined; signer = undefined;
    void previous?.close(); signerPool?.destroy(); signerPool = undefined;
    remember(SIGNER_KEY, null);
    update({ signerStatus: "disconnected", signerPubkey: "", signerKind: null, signerError: "", signerLink: "", signerAuthUrl: "", signerCanPost: false, signerCanReply: false, signerCanUpload: false });
}
export function restoreConnections() {
    if (restored) return; restored = true;
    const wallet = read(WALLET_KEY), savedSigner = read(SIGNER_KEY);
    if (wallet) void connectWallet(wallet);
    if (!ENABLE_NOSTR_CONNECT || !savedSigner) return;
    try {
        const saved = JSON.parse(savedSigner) as RemoteSession | { kind: "extension"; pubkey: string };
        if (saved.kind === "remote" && HEX.test(saved.clientKey) && HEX.test(saved.pubkey)) void connectRemote(undefined, saved);
        // Extensions ask for account access only after a user gesture.
    } catch { remember(SIGNER_KEY, null); }
}
