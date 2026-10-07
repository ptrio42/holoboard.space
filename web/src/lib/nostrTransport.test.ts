import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { queryNostr } from "./nostrTransport";
import { safeRelay, relayCandidates } from "./relayPolicy";

class FakeSocket extends EventTarget {
    static OPEN = 1;
    static sockets: FakeSocket[] = [];
    readyState = 0;
    sent: unknown[][] = [];
    readonly url: string;
    constructor(url: string) { super(); this.url = url; FakeSocket.sockets.push(this); }
    open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    frame(data: unknown[]) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
beforeEach(() => { vi.useFakeTimers(); FakeSocket.sockets = []; vi.stubGlobal("WebSocket", FakeSocket); });
afterEach(() => { for (const socket of FakeSocket.sockets) socket.close(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const signed = () => finalizeEvent({ kind: 1, created_at: 100, tags: [], content: "valid" }, generateSecretKey());
describe("Nostr wire lifecycle", () => {
    it("does not queue an already cancelled read behind pending dials", async () => {
        const active = queryNostr({ kinds: [1] }, ["wss://dial1.example.com", "wss://dial2.example.com", "wss://dial3.example.com"]);
        await flush(); expect(FakeSocket.sockets).toHaveLength(3);
        const controller = new AbortController(); controller.abort();
        const result = await queryNostr({ kinds: [1] }, ["wss://cancelled.example.com"], { signal: controller.signal });
        expect(result.relays["wss://cancelled.example.com"]).toBe("cancelled");
        expect(FakeSocket.sockets).toHaveLength(3);
        for (const socket of FakeSocket.sockets) socket.close();
        await active;
    });
    it("cancels before a socket opens without issuing a delayed REQ", async () => {
        const controller = new AbortController();
        const query = queryNostr({ kinds: [1] }, ["wss://cancel.example.com"], { signal: controller.signal });
        await flush(); controller.abort(); FakeSocket.sockets[0].open(); await flush();
        const result = await query;
        expect(FakeSocket.sockets[0].sent).toEqual([]); expect(result.complete).toBe(false);
    });
    it("returns an exact ID immediately without requiring EOSE", async () => {
        const note = signed();
        const query = queryNostr({ ids: [note.id] }, ["wss://found.example.com"], { first: true });
        await flush(); const socket = FakeSocket.sockets[0]; socket.open(); await flush();
        const id = socket.sent[0][1]; socket.frame(["EVENT", id, note]);
        const result = await query;
        expect(result.events.map((event) => event.id)).toEqual([note.id]); expect(result.complete).toBe(false);
        expect(socket.sent.at(-1)).toEqual(["CLOSE", id]);
    });
    it("retains observed events on timeout and distinguishes actual EOSE", async () => {
        const note = signed();
        const query = queryNostr({ kinds: [1] }, ["wss://slow.example.com"], { timeout: 1000 });
        await flush(); const socket = FakeSocket.sockets[0]; socket.open(); await flush();
        socket.frame(["EVENT", socket.sent[0][1], note]);
        await vi.advanceTimersByTimeAsync(1000);
        const result = await query;
        expect(result.events).toHaveLength(1); expect(result.relays[socket.url]).toBe("timeout"); expect(result.complete).toBe(false);
        const second = queryNostr({ kinds: [1] }, [socket.url]); await flush();
        socket.frame(["EOSE", socket.sent.at(-1)![1]]);
        expect((await second).complete).toBe(true);
    });
    it("rejects a signed event with a forged ID", async () => {
        const note = signed();
        const query = queryNostr({ kinds: [1] }, ["wss://forged.example.com"]);
        await flush(); const socket = FakeSocket.sockets[0]; socket.open(); await flush();
        const id = socket.sent[0][1]; socket.frame(["EVENT", id, { ...note, id: "f".repeat(64) }]); socket.frame(["EOSE", id]);
        expect((await query).events).toEqual([]);
    });
    it("multiplexes requests to one relay and closes them independently", async () => {
        const first = queryNostr({ kinds: [0] }, ["wss://shared.example.com"]);
        const second = queryNostr({ kinds: [1] }, ["wss://shared.example.com"]);
        await flush(); expect(FakeSocket.sockets).toHaveLength(1);
        const socket = FakeSocket.sockets[0]; socket.open(); await flush();
        const reqs = socket.sent.filter((message) => message[0] === "REQ"); expect(reqs).toHaveLength(2);
        socket.frame(["CLOSED", reqs[0][1], "restricted"]); socket.frame(["EOSE", reqs[1][1]]);
        expect((await first).complete).toBe(false); expect((await second).complete).toBe(true);
    });
});
it("rejects local, insecure, credential-bearing and oversized untrusted hints", () => {
    for (const url of ["ws://example.com", "wss://127.0.0.1", "wss://[::1]", "wss://relay.local", "wss://user:pass@example.com", "wss://example.com/#token", "wss://example.com:444", `wss://example.com/${"a".repeat(2048)}`]) expect(safeRelay(url)).toBeNull();
    expect(relayCandidates(["wss://EXAMPLE.com/", "wss://example.com"])).toEqual(["wss://example.com"]);
});

it("reserves bounded pool capacity for outboxes by displacing fallback reads", async () => {
    const controller = new AbortController();
    const defaults = Array.from({ length: 8 }, (_, index) => queryNostr({ kinds: [1] }, [`wss://fallback${index}.example.com`], { signal: controller.signal }));
    for (let i = 0; i < 5; i++) {
        await flush();
        for (const socket of FakeSocket.sockets) if (socket.readyState === 0) socket.open();
    }
    await flush(); expect(FakeSocket.sockets).toHaveLength(8);
    const note = signed();
    const outbox = queryNostr({ ids: [note.id] }, ["wss://priority.example.com"], { first: true, priority: 2 });
    await flush();
    const socket = FakeSocket.sockets.at(-1)!;
    expect(socket.url).toBe("wss://priority.example.com");
    socket.open(); await flush(); socket.frame(["EVENT", socket.sent[0][1], note]);
    expect((await outbox).events[0].id).toBe(note.id);
    controller.abort();
    const results = await Promise.all(defaults);
    expect(results.some((result) => Object.values(result.relays).includes("budget"))).toBe(true);
});
