import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { BunkerPointer } from "nostr-tools/nip46";
import { connectRemote, disconnectSigner, getConnectedSigner, getConnections } from "./connections";

const fixtures = vi.hoisted(() => ({ clients: [] as Record<string, unknown>[], pools: [] as Record<string, unknown>[], fromURI: vi.fn(), request: vi.fn(), sign: vi.fn(), account: "", pointer: { pubkey: "a".repeat(64), relays: ["wss://relay.example.com"], secret: "one-time-secret" } }));
vi.mock("../config", () => ({ ENABLE_NOSTR_CONNECT: true, PUBLIC_RELAYS: ["wss://relay.example.com"], RELAY_URL: "wss://relay.example.com" }));
vi.mock("nostr-tools/abstract-pool", () => ({ AbstractSimplePool: class {
    constructor(options: Record<string, unknown>) { fixtures.pools.push({ ...options, destroy: vi.fn() }); Object.assign(this, fixtures.pools.at(-1)); }
} }));
vi.mock("nostr-tools/nip46", () => {
    const create = (_key: Uint8Array, pointer: BunkerPointer) => {
        const client = { bp: pointer, getPublicKey: async () => fixtures.account, sendRequest: fixtures.request, signEvent: fixtures.sign, close: vi.fn(async () => {}) };
        fixtures.clients.push(client); return client;
    };
    return { BunkerSigner: { fromBunker: create, fromURI: fixtures.fromURI }, parseBunkerInput: async () => fixtures.pointer,
        createNostrConnectURI: () => "nostrconnect://fixture?secret=fixture" };
});
const key = generateSecretKey();
const template = { kind: 9734, created_at: 1700000000, content: "", tags: [] };
beforeEach(() => {
    fixtures.clients.length = 0; fixtures.pools.length = 0; fixtures.request.mockReset(); fixtures.sign.mockReset(); fixtures.fromURI.mockReset();
    fixtures.account = getPublicKey(key); fixtures.pointer = { pubkey: "a".repeat(64), relays: ["wss://relay.example.com"], secret: "one-time-secret" };
    fixtures.request.mockImplementation(async (method: string) => method === "switch_relays" ? "null" : "ack");
    fixtures.sign.mockImplementation(async (input: typeof template) => finalizeEvent(input, key));
    vi.stubGlobal("WebSocket", class { static OPEN = 1; send() {} });
    vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:4173" } });
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
});
afterEach(() => { disconnectSigner(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("binds the user account separately from the bunker key and sends client metadata in parameter four", async () => {
    await connectRemote("bunker://fixture");
    expect(getConnections()).toMatchObject({ signerStatus: "connected", signerPubkey: getPublicKey(key) });
    expect(fixtures.request.mock.calls[0]).toEqual(["connect", ["a".repeat(64), "one-time-secret", "sign_event:9734", JSON.stringify({ name: "Holoboard", url: "http://127.0.0.1:4173" })]]);
    await expect(getConnectedSigner()!.signEvent(template)).resolves.toHaveProperty("pubkey", getPublicKey(key));
    expect(fixtures.request.mock.calls.map(call => call[0])).toEqual(["connect", "switch_relays"]);
});
it("validates switched relay destinations before creating a replacement subscription", async () => {
    fixtures.request.mockImplementation(async (method: string) => method === "switch_relays" ? '["ws://127.0.0.1:9000"]' : "ack");
    await connectRemote("bunker://fixture"); expect(fixtures.clients).toHaveLength(1);
    disconnectSigner();
    fixtures.request.mockImplementation(async (method: string) => method === "switch_relays" ? '["wss://new-relay.example.com"]' : "ack");
    await connectRemote("bunker://fixture");
    expect(fixtures.clients).toHaveLength(3);
    expect(fixtures.clients.at(-1)?.bp).toMatchObject({ relays: ["wss://new-relay.example.com/"], secret: null });
    expect(fixtures.clients[1].close).toHaveBeenCalledOnce();
    expect((fixtures.pools.at(-1)?.allowConnectingToRelay as (url: string) => boolean)("wss://new-relay.example.com")).toBe(true);
    disconnectSigner();
    expect((fixtures.pools.at(-1)?.allowConnectingToRelay as (url: string) => boolean)("wss://new-relay.example.com")).toBe(false);
});
it("cannot change relays or restore a connection after a cancelled switch request completes late", async () => {
    let deliver!: (value: string) => void;
    fixtures.request.mockImplementation((method: string) => method === "switch_relays" ? new Promise(resolve => { deliver = resolve; }) : Promise.resolve("ack"));
    const connecting = connectRemote("bunker://fixture");
    await vi.waitFor(() => expect(deliver).toBeTypeOf("function"));
    disconnectSigner(); await connecting;
    deliver('["wss://new-relay.example.com"]'); await Promise.resolve();
    expect(fixtures.clients).toHaveLength(1); expect(getConnectedSigner()).toBeUndefined();
    expect(getConnections().signerStatus).toBe("disconnected");
});
it("serializes user signing and revokes the pool after a timed-out RPC", async () => {
    await connectRemote("bunker://fixture");
    fixtures.sign.mockReturnValue(new Promise(() => {})); vi.useFakeTimers();
    const first = getConnectedSigner()!.signEvent(template);
    const failed = expect(first).rejects.toThrow("did not respond");
    await expect(getConnectedSigner()!.signEvent(template)).rejects.toThrow("already waiting");
    await vi.advanceTimersByTimeAsync(120000); await failed;
    expect(getConnections().signerStatus).toBe("disconnected");
    expect(fixtures.pools[0].destroy).toHaveBeenCalledOnce();
});
it("bounds retained remote RPC bookkeeping over a connected session", async () => {
    await connectRemote("bunker://fixture"); const signer = getConnectedSigner()!;
    for (let i = 0; i < 64; i++) await signer.signEvent(template);
    await expect(signer.signEvent(template)).rejects.toThrow("Reconnect");
    expect(fixtures.sign).toHaveBeenCalledTimes(64); expect(getConnectedSigner()).toBeUndefined();
});
it("refuses oversized relay lists before constructing a bunker client", async () => {
    fixtures.pointer.relays = Array.from({ length: 5 }, (_, i) => `wss://relay${i}.example.com`);
    await connectRemote("bunker://fixture"); expect(fixtures.clients).toHaveLength(0);
    expect(getConnections().signerStatus).toBe("disconnected");
});
it("rejects account changes when restoring a saved remote transport session", async () => {
    await connectRemote(undefined, { kind: "remote", clientKey: "b".repeat(64), pointer: fixtures.pointer, pubkey: "c".repeat(64) });
    expect(getConnectedSigner()).toBeUndefined(); expect(getConnections().signerStatus).toBe("disconnected");
    expect(fixtures.request).not.toHaveBeenCalled(); expect(fixtures.clients[0].close).toHaveBeenCalled();
});
