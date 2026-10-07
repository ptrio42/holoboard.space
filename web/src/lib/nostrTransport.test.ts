import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { publishSignedEvent, queryNostr } from "./nostrTransport";
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
describe("public delivery acknowledgements", () => {
    it("shares a read socket, matches exact boolean OK frames and keeps acknowledgement ownership after EOSE", async () => {
        const event = signed(), url = "wss://delivery-shared.example.com";
        const read = queryNostr({ kinds: [1] }, [url]);
        const publish = publishSignedEvent(event, [url]);
        await flush(); expect(FakeSocket.sockets).toHaveLength(1);
        const socket = FakeSocket.sockets[0]; socket.open(); await flush();
        const req = socket.sent.find(frame => frame[0] === "REQ")!;
        socket.frame(["EOSE", req[1]]); expect((await read).complete).toBe(true);
        socket.frame(["OK", "f".repeat(64), true, ""]); socket.frame(["OK", event.id, "true", ""]);
        socket.frame(["OK", event.id, true]); await flush();
        expect(socket.readyState).toBe(1);
        socket.frame(["OK", event.id, true, "duplicate: already stored"]);
        expect((await publish).relays[url]).toEqual({ state: "accepted", detail: "duplicate: already stored" });
        expect(socket.sent.filter(frame => frame[0] === "EVENT")).toHaveLength(1);
        expect(socket.sent.filter(frame => frame[0] === "CLOSE")).toEqual([["CLOSE", req[1]]]);
        await vi.advanceTimersByTimeAsync(15000); expect(socket.readyState).toBe(3);
    });
    it("retains partial delivery and treats a missing acknowledgement as uncertain", async () => {
        const event = signed(), urls = ["wss://accepted.example.com", "wss://rejected.example.com", "wss://uncertain.example.com"];
        const publish = publishSignedEvent(event, urls, { timeout: 1000 }); await flush();
        for (const socket of FakeSocket.sockets) socket.open(); await flush();
        FakeSocket.sockets[0].frame(["OK", event.id, true, ""]);
        FakeSocket.sockets[1].frame(["OK", event.id, false, "restricted: registration required"]);
        await vi.advanceTimersByTimeAsync(1000);
        expect((await publish).relays).toMatchObject({ [urls[0]]: { state: "accepted" }, [urls[1]]: { state: "rejected" }, [urls[2]]: { state: "uncertain" } });
    });
    it("cancels before opening without sending and after sending without closing another reader", async () => {
        const event = signed(), url = "wss://cancel-delivery.example.com", before = new AbortController();
        const readController = new AbortController();
        const read = queryNostr({ kinds: [1] }, [url], { signal: readController.signal });
        const first = publishSignedEvent(event, [url], { signal: before.signal }); await flush(); before.abort();
        expect((await first).relays[url].state).toBe("not-sent");
        const socket = FakeSocket.sockets[0]; socket.open(); await flush();
        expect(socket.sent.some(frame => frame[0] === "EVENT")).toBe(false);
        const after = new AbortController();
        const second = publishSignedEvent(event, [url], { signal: after.signal }); await flush(); after.abort();
        expect((await second).relays[url].state).toBe("uncertain"); expect(socket.readyState).toBe(1);
        expect(socket.sent.some(frame => frame[0] === "CLOSE")).toBe(false);
        readController.abort(); await read;
    });
    it("rechecks signatures and rejects unsafe destinations before opening a socket", async () => {
        const event = signed(); event.sig = "0".repeat(128);
        await expect(publishSignedEvent(event, ["wss://relay.example.com"])).rejects.toThrow("verified");
        await expect(publishSignedEvent(signed(), ["wss://127.0.0.1"])).rejects.toThrow("destinations");
        expect(FakeSocket.sockets).toEqual([]);
    });
    it("bounds concurrent publications without a hidden queue", async () => {
        const controller = new AbortController();
        const active = Array.from({ length: 4 }, (_, i) => publishSignedEvent(signed(), [`wss://publication${i}.example.com`], { signal: controller.signal }));
        const fifth = await publishSignedEvent(signed(), ["wss://publication5.example.com"]);
        expect(fifth.relays["wss://publication5.example.com"]).toMatchObject({ state: "not-sent", detail: "Publication budget exhausted." });
        controller.abort(); await Promise.all(active);
        expect(FakeSocket.sockets.length).toBeLessThanOrEqual(3);
    });
    it("reports closure after sending as uncertain and contains observer exceptions", async () => {
        const event = signed(), url = "wss://closed-delivery.example.com";
        const publish = publishSignedEvent(event, [url], { onOutcome: () => { throw new Error("observer failed"); } });
        await flush(); const socket = FakeSocket.sockets[0]; socket.open(); await flush(); socket.close();
        expect((await publish).relays[url].state).toBe("uncertain");
    });
});
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
    it("cancels a shared connecting reader promptly without stopping the other reader", async () => {
        const controller = new AbortController();
        const first = queryNostr({ kinds: [0] }, ["wss://pending-shared.example.com"], { signal: controller.signal });
        const second = queryNostr({ kinds: [1] }, ["wss://pending-shared.example.com"]);
        await flush(); controller.abort();
        expect((await first).relays["wss://pending-shared.example.com"]).toBe("cancelled");
        const socket = FakeSocket.sockets[0]; expect(socket.readyState).toBe(0);
        socket.open(); await flush();
        const requests = socket.sent.filter((message) => message[0] === "REQ");
        expect(requests).toHaveLength(1); expect(requests[0][2]).toEqual({ kinds: [1] });
        socket.frame(["EOSE", requests[0][1]]); expect((await second).complete).toBe(true);
    });
    it("keeps cancelled handshakes within the physical dial budget", async () => {
        const controller = new AbortController();
        const first = queryNostr({ kinds: [1] }, ["wss://pending1.example.com", "wss://pending2.example.com", "wss://pending3.example.com"], { signal: controller.signal });
        await flush(); expect(FakeSocket.sockets).toHaveLength(3);
        controller.abort(); await first;
        const nextController = new AbortController();
        const next = queryNostr({ kinds: [1] }, ["wss://pending4.example.com", "wss://pending5.example.com"], { signal: nextController.signal });
        await flush(); expect(FakeSocket.sockets).toHaveLength(3);
        for (const socket of FakeSocket.sockets.slice()) socket.open();
        await flush(); expect(FakeSocket.sockets).toHaveLength(5);
        nextController.abort(); await next;
    });
    it("keeps a failed handshake's idle cleanup from evicting a replacement connection", async () => {
        const url = "wss://replacement.example.com";
        const failed = queryNostr({ kinds: [0] }, [url]);
        await flush(); FakeSocket.sockets[0].close(); await failed;
        const controller = new AbortController();
        const replacement = queryNostr({ kinds: [1] }, [url], { signal: controller.signal, timeout: 60_000 });
        await flush(); FakeSocket.sockets[1].open(); await flush();
        await vi.advanceTimersByTimeAsync(15_000);
        const shared = queryNostr({ kinds: [0] }, [url], { signal: controller.signal, timeout: 60_000 });
        await flush();
        expect(FakeSocket.sockets).toHaveLength(2);
        controller.abort(); await Promise.all([replacement, shared]);
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
