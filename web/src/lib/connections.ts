import { generateSecretKey, getPublicKey, verifyEvent, type Event, type EventTemplate } from "nostr-tools/pure";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import type { BunkerSigner, BunkerPointer } from "nostr-tools/nip46";
import type { AbstractSimplePool } from "nostr-tools/abstract-pool";
import type { NWCClient } from "@getalby/sdk/nwc";
import { PUBLIC_RELAYS } from "../config";
import { PaymentRejected, withTimeout, type PaymentWallet } from "./walletPayment";
import { attachWalletAccount, clearWalletAccount, refreshWalletAccount } from "./walletAccount";

export interface ConnectedSigner {
    getPublicKey(): Promise<string>;
    signEvent(template: EventTemplate): Promise<Event>;
}
type ConnectionStatus = "disconnected" | "connecting" | "connected";
export interface Connections {
    walletStatus: ConnectionStatus; walletName: string; walletError: string; walletCanRetry: boolean;
    signerStatus: ConnectionStatus; signerPubkey: string; signerKind: "extension" | "remote" | null;
    signerError: string; signerLink: string; signerAuthUrl: string;
}
let state: Connections = {
    walletStatus: "disconnected", walletName: "", walletError: "", walletCanRetry: false,
    signerStatus: "disconnected", signerPubkey: "", signerKind: null,
    signerError: "", signerLink: "", signerAuthUrl: "",
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
            ...(info.methods.includes("lookup_invoice") ? { lookupPayment: async (paymentHash: string) => {
                try {
                    const transaction = await withTimeout(client.lookupInvoice({ payment_hash: paymentHash }), 12000, "Could not check the wallet payment status.");
                    if (transaction.payment_hash !== paymentHash || transaction.type === "incoming") return { state: "unknown" as const };
                    if (transaction.state === "settled" || transaction.settled_at > 0) return { state: "paid" as const, preimage: transaction.preimage };
                    return { state: transaction.state === "failed" ? "unpaid" as const : "pending" as const };
                } catch { return { state: "unknown" as const }; }
            } } : {}),
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
function bindSigner(candidate: ConnectedSigner, pubkey: string): ConnectedSigner {
    if (!HEX.test(pubkey)) throw new Error("The signer returned an invalid public key.");
    const generation = signerGeneration;
    return {
        getPublicKey: async () => pubkey,
        signEvent: async (template) => {
            try {
                const event = await withTimeout(candidate.signEvent(template), 120000, "The signer did not respond. Return to Holoboard after approving the request, or try again.");
                if (!verifyEvent(event) || event.pubkey !== pubkey || event.kind !== template.kind || event.content !== template.content || event.created_at !== template.created_at || JSON.stringify(event.tags) !== JSON.stringify(template.tags)) {
                    throw new Error("The signer changed the requested event or account.");
                }
                return event;
            } finally {
                if (generation === signerGeneration) update({ signerAuthUrl: "" });
            }
        },
    };
}
export async function connectExtension() {
    disconnectSigner();
    const generation = signerGeneration;
    update({ signerStatus: "connecting", signerKind: "extension" });
    try {
        const candidate = extension();
        if (!candidate) throw new Error("No Nostr browser extension was found. Use Amber or a remote signer instead.");
        const pubkey = await withTimeout(candidate.getPublicKey(), 30000, "The extension did not respond. Try connecting again.");
        if (generation !== signerGeneration) return;
        signer = bindSigner(candidate, pubkey);
        remember(SIGNER_KEY, JSON.stringify({ kind: "extension", pubkey }));
        update({ signerStatus: "connected", signerPubkey: pubkey });
    } catch (failure) { if (generation === signerGeneration) update({ signerStatus: "disconnected", signerError: failure instanceof Error ? failure.message : "The signer declined the connection." }); }
}
interface RemoteSession { kind: "remote"; clientKey: string; pointer: BunkerPointer; pubkey: string }
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
async function finishRemote(candidate: BunkerSigner, clientKey: Uint8Array, generation: number, expectedPubkey?: string) {
    const pubkey = await withTimeout(candidate.getPublicKey(), 20000, "The signer did not return an account. Try connecting again.");
    if (generation !== signerGeneration) { await candidate.close(); return; }
    if (expectedPubkey && expectedPubkey !== pubkey) throw new Error("The connected signer changed account. Connect again to choose the new account.");
    signer = bindSigner(candidate, pubkey); remote = candidate;
    const session: RemoteSession = { kind: "remote", clientKey: bytesToHex(clientKey), pointer: { ...candidate.bp, secret: null }, pubkey };
    remember(SIGNER_KEY, JSON.stringify(session));
    update({ signerStatus: "connected", signerKind: "remote", signerPubkey: pubkey, signerLink: "", signerAuthUrl: "" });
    // Older signers may not implement switch_relays. Signing remains available.
    void withTimeout(candidate.switchRelays(), 5000, "Signer relay update timed out.").then(() => {
        if (generation === signerGeneration) { session.pointer = { ...candidate.bp, secret: null }; remember(SIGNER_KEY, JSON.stringify(session)); }
    }).catch(() => {});
}
export async function connectRemote(input?: string, saved?: RemoteSession) {
    disconnectSigner();
    const generation = signerGeneration;
    const controller = new AbortController(); signerAbort = controller;
    update({ signerStatus: "connecting", signerKind: "remote" });
    let candidate: BunkerSigner | undefined;
    try {
        const [{ BunkerSigner, parseBunkerInput, createNostrConnectURI }, { AbstractSimplePool }] = await Promise.all([import("nostr-tools/nip46"), import("nostr-tools/abstract-pool")]);
        if (generation !== signerGeneration) return;
        const pool = new AbstractSimplePool({ verifyEvent, websocketImplementation: signerWebSocket(), maxWaitForConnection: 10000 }); signerPool = pool;
        const key = saved ? hexToBytes(saved.clientKey) : generateSecretKey();
        const params = { pool, skipSwitchRelays: true, onauth: (url: string) => authUrl(url, generation) };
        if (input || saved) {
            if (input && !input.trim().startsWith("bunker://")) throw new Error("Paste a bunker:// connection string from your signer.");
            const pointer = saved?.pointer ?? await parseBunkerInput(input!.trim());
            if (generation !== signerGeneration) return;
            if (!pointer || !HEX.test(pointer.pubkey) || !pointer.relays.length) throw new Error("The signer connection string is incomplete.");
            pointer.relays.forEach(validateRelay);
            candidate = BunkerSigner.fromBunker(key, pointer, params); remote = candidate;
            if (!saved) await withTimeout(candidate.sendRequest("connect", [pointer.pubkey, pointer.secret ?? "", "sign_event:9734", JSON.stringify({ name: "Holoboard", url: window.location.origin })]), 60000, "The signer did not approve the connection. Try again.");
        } else {
            const relays = PUBLIC_RELAYS.slice(0, 2).map(validateRelay);
            const uri = createNostrConnectURI({ clientPubkey: getPublicKey(key), relays, secret: bytesToHex(generateSecretKey()), perms: ["sign_event:9734"], name: "Holoboard", url: window.location.origin });
            update({ signerLink: uri });
            const timer = setTimeout(() => controller.abort(), 180000);
            try { candidate = await BunkerSigner.fromURI(key, uri, params, controller.signal); }
            finally { clearTimeout(timer); }
        }
        await finishRemote(candidate, key, generation, saved?.pubkey);
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
    update({ signerStatus: "disconnected", signerPubkey: "", signerKind: null, signerError: "", signerLink: "", signerAuthUrl: "" });
}
export function restoreConnections() {
    if (restored) return; restored = true;
    const wallet = read(WALLET_KEY), savedSigner = read(SIGNER_KEY);
    if (wallet) void connectWallet(wallet);
    if (!savedSigner) return;
    try {
        const saved = JSON.parse(savedSigner) as RemoteSession | { kind: "extension"; pubkey: string };
        if (saved.kind === "remote" && HEX.test(saved.clientKey) && HEX.test(saved.pubkey)) void connectRemote(undefined, saved);
        // Extensions ask for account access only after a user gesture.
    } catch { remember(SIGNER_KEY, null); }
}
