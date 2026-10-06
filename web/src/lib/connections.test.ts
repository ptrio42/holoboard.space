import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { connectExtension, connectWallet, disconnectSigner, disconnectWallet, getConnectedSigner, getConnections, getPaymentWallet, validateNwcUri, validateRelay } from "./connections";
import { PaymentRejected } from "./walletPayment";

const mock = vi.hoisted(() => ({ info: vi.fn(), pay: vi.fn(), lookup: vi.fn(), close: vi.fn() }));
vi.mock("@getalby/sdk/nwc", () => {
    class Nip47WalletError extends Error { code: string; constructor(message: string, code: string) { super(message); this.code = code; } }
    class NWCClient {
        walletPubkey = "a".repeat(64); publicKey = "b".repeat(64);
        getInfo = mock.info; payInvoice = mock.pay; lookupInvoice = mock.lookup; close = mock.close;
    }
    return { NWCClient, Nip47WalletError };
});
const uri = `nostr+walletconnect://${"a".repeat(64)}?relay=wss%3A%2F%2Frelay.example.com&secret=${"c".repeat(64)}`;
let storage: Map<string, string>;
beforeEach(() => {
    Object.values(mock).forEach((method) => method.mockReset());
    storage = new Map();
    vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    vi.stubGlobal("window", {});
    mock.info.mockResolvedValue({ alias: "Test wallet", network: "mainnet", methods: ["pay_invoice", "lookup_invoice"] });
    mock.pay.mockResolvedValue({ preimage: "proof" });
    mock.lookup.mockResolvedValue({ type: "outgoing", payment_hash: "hash", state: "settled", preimage: "proof" });
});
afterEach(() => { disconnectWallet(); disconnectSigner(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("optional wallet connections", () => {
    it("keeps anonymous WebLN payments available without NWC or a signer", async () => {
        const sendPayment = vi.fn(async () => ({}));
        vi.stubGlobal("window", { webln: { enable: async () => {}, sendPayment } });
        expect(getConnectedSigner()).toBeUndefined();
        const wallet = getPaymentWallet()!;
        expect(wallet.kind).toBe("webln");
        await wallet.sendPayment("invoice");
        expect(sendPayment).toHaveBeenCalledExactlyOnceWith("invoice");
        expect(storage.size).toBe(0);
    });
    it("connects without paying and removes the session on disconnect", async () => {
        await connectWallet(uri);
        expect(getConnections().walletStatus).toBe("connected");
        expect(mock.pay).not.toHaveBeenCalled();
        expect(storage.get("holoboard-nwc")).toBe(uri);
        expect(getPaymentWallet()?.kind).toBe("nwc");
        disconnectWallet();
        expect(getPaymentWallet()).toBeUndefined();
        expect(storage.has("holoboard-nwc")).toBe(false);
    });
    it("rejects insecure relays and missing wallet secrets before connecting", async () => {
        expect(() => validateRelay("wss://relay.example.com")).not.toThrow();
        expect(() => validateRelay("ws://127.0.0.1:3334")).not.toThrow();
        for (const relay of ["ws://relay.example.com", "https://relay.example.com", "wss://user:password@relay.example.com"]) expect(() => validateRelay(relay)).toThrow();
        expect(() => validateNwcUri(uri.replace(/&secret=.*/, ""))).toThrow();
        expect(() => validateNwcUri(uri.replace("nostr+walletconnect", "https"))).toThrow();
        await connectWallet("invalid");
        expect(mock.info).not.toHaveBeenCalled();
    });
    it("accepts receiving-only and read-only connections without a payer", async () => {
        for (const info of [{ methods: ["make_invoice"], network: "mainnet" }, { methods: ["get_balance"], network: "mainnet" }]) {
            mock.info.mockResolvedValueOnce(info);
            await connectWallet(uri);
            expect(getConnections().walletStatus).toBe("connected");
            expect(getPaymentWallet()).toBeUndefined();
        }
    });
    it("declines testnet connections", async () => {
        for (const info of [{ methods: ["pay_invoice"], network: "testnet" }]) {
            mock.info.mockResolvedValueOnce(info);
            await connectWallet(uri);
            expect(getConnections().walletStatus).toBe("disconnected");
            expect(getPaymentWallet()).toBeUndefined();
        }
    });
    it("does not restore a cancelled connection when its response arrives late", async () => {
        let complete!: (value: unknown) => void;
        mock.info.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
        const connecting = connectWallet(uri);
        await vi.waitFor(() => expect(getConnections().walletStatus).toBe("connecting"));
        await vi.waitFor(() => expect(mock.info).toHaveBeenCalledTimes(1));
        disconnectWallet();
        complete({ network: "mainnet", methods: ["pay_invoice"] });
        await connecting;
        expect(getConnections().walletStatus).toBe("disconnected");
        expect(storage.has("holoboard-nwc")).toBe(false);
        expect(getPaymentWallet()).toBeUndefined();
        expect(mock.close).toHaveBeenCalledTimes(1);
    });
    it("does not treat missing or mismatched lookup responses as permission to retry", async () => {
        await connectWallet(uri);
        mock.lookup.mockResolvedValueOnce({ payment_hash: "another-hash", state: "failed" });
        expect(await getPaymentWallet()!.lookupPayment!("hash")).toEqual({ state: "unknown" });
        mock.lookup.mockRejectedValueOnce(new Error("NOT_FOUND"));
        expect(await getPaymentWallet()!.lookupPayment!("hash")).toEqual({ state: "unknown" });
    });
    it("distinguishes a quota rejection from an uncertain network result", async () => {
        const { Nip47WalletError } = await import("@getalby/sdk/nwc");
        await connectWallet(uri);
        mock.pay.mockRejectedValueOnce(new Nip47WalletError("quota", "QUOTA_EXCEEDED"));
        await expect(getPaymentWallet()!.sendPayment("invoice")).rejects.toBeInstanceOf(PaymentRejected);
        mock.pay.mockRejectedValueOnce(new Error("timeout"));
        await expect(getPaymentWallet()!.sendPayment("invoice")).rejects.not.toBeInstanceOf(PaymentRejected);
    });
});

describe("signer account and event validation", () => {
    it("does not accept changes to the event or connected account", async () => {
        const secret = generateSecretKey(), other = generateSecretKey();
        const signEvent = vi.fn();
        vi.stubGlobal("window", { nostr: { getPublicKey: async () => getPublicKey(secret), signEvent } });
        await connectExtension();
        const template = { kind: 9734, created_at: 1700000000, content: "", tags: [["amount", "1000"]] };
        signEvent.mockResolvedValueOnce(finalizeEvent(template, secret));
        await expect(getConnectedSigner()!.signEvent(template)).resolves.toHaveProperty("pubkey", getPublicKey(secret));
        signEvent.mockResolvedValueOnce(finalizeEvent({ ...template, tags: [["amount", "2000"]] }, secret));
        await expect(getConnectedSigner()!.signEvent(template)).rejects.toThrow("changed");
        signEvent.mockResolvedValueOnce(finalizeEvent(template, other));
        await expect(getConnectedSigner()!.signEvent(template)).rejects.toThrow("account");
    });
});
