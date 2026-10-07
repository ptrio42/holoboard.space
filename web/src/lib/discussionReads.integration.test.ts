import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, matchFilter, type Event as NostrEvent, type Filter } from "nostr-tools";
import { DiscussionCoordinator, type DiscussionHandle } from "./discussionReads";
import { nostrCache } from "./nostrCache";

vi.mock("../config", () => ({ RELAY_URL: "wss://wire.example.com", PUBLIC_RELAYS: [] }));
class WireRelay extends EventTarget {
    static OPEN = 1;
    static sockets: WireRelay[] = [];
    static events: NostrEvent[] = [];
    static hold = false;
    static autoOpen = true;
    static forged?: NostrEvent;
    readyState = 0;
    sent: unknown[][] = [];
    readonly url: string;
    constructor(url: string) {
        super(); this.url = url; WireRelay.sockets.push(this);
        if (WireRelay.autoOpen) queueMicrotask(() => this.open());
    }
    open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
    send(data: string) {
        const message = JSON.parse(data) as [string, string, Filter]; this.sent.push(message);
        if (message[0] !== "REQ") return;
        queueMicrotask(() => {
            const events = WireRelay.events.filter((event) => matchFilter(message[2], event))
                .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)).slice(0, message[2].limit ?? 512);
            for (const event of events) this.frame(["EVENT", message[1], event]);
            if (WireRelay.forged) this.frame(["EVENT", message[1], WireRelay.forged]);
            if (!WireRelay.hold) this.frame(["EOSE", message[1]]);
        });
    }
    frame(message: unknown[]) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
const handles: DiscussionHandle[] = [];
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function fixture() {
    const secret = generateSecretKey();
    const focus = finalizeEvent({ kind: 1, created_at: 100, tags: [], content: "focus" }, secret);
    const child = finalizeEvent({ kind: 1, created_at: 101, tags: [["e", focus.id, "", "root"]], content: "reply" }, secret);
    nostrCache.put(finalizeEvent({ kind: 10002, created_at: 100, tags: [], content: "" }, secret));
    return { focus, child };
}
beforeEach(() => {
    WireRelay.sockets = []; WireRelay.events = []; WireRelay.hold = false; WireRelay.autoOpen = true; WireRelay.forged = undefined;
    vi.stubGlobal("WebSocket", WireRelay);
});
afterEach(() => {
    for (const handle of handles.splice(0)) handle.close();
    for (const socket of WireRelay.sockets) socket.close();
    vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

it("assembles signed EVENT frames and sends CLOSE after real EOSE without publishing", async () => {
    const { focus, child } = fixture(); WireRelay.events = [child]; WireRelay.forged = { ...child, id: "f".repeat(64) };
    const handle = new DiscussionCoordinator({ maxRelays: 1 }).open({ focusId: focus.id, seed: focus }); handles.push(handle);
    const result = await handle.loadMore();
    expect(result.graph.nodes.get(`event:${child.id}`)?.parent).toBe(`event:${focus.id}`);
    expect(result.graph.events.has(WireRelay.forged.id)).toBe(false);
    expect(WireRelay.sockets).toHaveLength(1);
    const messages = WireRelay.sockets[0].sent;
    for (const req of messages.filter((message) => message[0] === "REQ")) expect(messages.filter((message) => message[0] === "CLOSE" && message[1] === req[1])).toHaveLength(1);
    expect(messages.every((message) => message[0] === "REQ" || message[0] === "CLOSE")).toBe(true);
});

it("retains streaming observations and closes the actual REQ only after the final view leaves", async () => {
    const { focus, child } = fixture(); WireRelay.events = [child]; WireRelay.hold = true;
    const coordinator = new DiscussionCoordinator({ maxRelays: 1 });
    const first = coordinator.open({ focusId: focus.id, seed: focus }), second = coordinator.open({ focusId: focus.id }); handles.push(first, second);
    const pending = first.loadMore();
    await vi.waitFor(() => expect(first.snapshot().graph.events.has(child.id)).toBe(true));
    const socket = WireRelay.sockets[0], req = socket.sent.find((message) => message[0] === "REQ")!;
    first.close(); expect(socket.sent.some((message) => message[0] === "CLOSE")).toBe(false);
    second.close(); await pending;
    expect(socket.sent.filter((message) => message[0] === "CLOSE" && message[1] === req[1])).toHaveLength(1);
    expect(second.snapshot().graph.events.has(child.id)).toBe(true);
    socket.frame(["EVENT", req[1], { ...child, id: "0".repeat(64) }]);
    expect(second.snapshot().graph.events.has("0".repeat(64))).toBe(false);
});

it("finishes cancellation while connecting and never sends a delayed REQ", async () => {
    vi.useFakeTimers(); WireRelay.autoOpen = false;
    const { focus } = fixture();
    const coordinator = new DiscussionCoordinator({ maxRelays: 1, maxSessions: 1 });
    const handle = coordinator.open({ focusId: focus.id, seed: focus }); handles.push(handle);
    let finished = false;
    const pending = handle.loadMore().then((result) => { finished = true; return result; });
    await flush(); expect(WireRelay.sockets).toHaveLength(1);
    handle.close(); await flush();
    expect(finished).toBe(true);
    WireRelay.sockets[0].open(); await flush();
    expect(WireRelay.sockets[0].sent).toEqual([]);
    expect((await pending).state).toBe("closed");
});

it("resolves an exact ancestor on EVENT without waiting for its relay's EOSE", async () => {
    const { focus: parent, child: focus } = fixture(); WireRelay.events = [parent]; WireRelay.hold = true;
    const handle = new DiscussionCoordinator({ maxRelays: 1 }).open({ focusId: focus.id, seed: focus }); handles.push(handle);
    const pending = handle.loadMore();
    await vi.waitFor(() => expect(handle.snapshot().graph.nodes.get(`event:${focus.id}`)?.parentState).toBe("resolved"));
    expect(handle.snapshot().coverage.find((item) => item.purpose === "ancestor")?.outcome).toBe("found");
    handle.close(); await pending;
    const ancestor = handle.snapshot().coverage.find((item) => item.purpose === "ancestor")!;
    expect(ancestor.satisfied).toBe(true); expect(ancestor.exhausted).toBe(false);
});
