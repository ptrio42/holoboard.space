import { afterEach, beforeEach, expect, it, vi } from "vitest";

class Socket extends EventTarget {
    static OPEN = 1;
    static sockets: Socket[] = [];
    readyState = 0;
    constructor() { super(); Socket.sockets.push(this); }
    send(data: unknown) { void data; }
    close(code?: number) {
        if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) throw new DOMException("Invalid close code", "InvalidAccessError");
        if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close"));
    }
    open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
}
beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); Socket.sockets = []; });
afterEach(() => { for (const socket of Socket.sockets) socket.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("shares connection and subscription budgets between all socket consumers", async () => {
    vi.stubGlobal("WebSocket", Socket);
    const { socketUsage } = await import("./socketBudget");
    const sockets: Socket[] = [];
    for (let i = 0; i < 4; i++) sockets.push(new WebSocket(`wss://relay${i}.example.com`) as unknown as Socket);
    expect(() => new WebSocket("wss://overflow.example.com")).toThrow("budget");
    for (const socket of sockets) socket.open();
    for (let i = 4; i < 12; i++) { const socket = new WebSocket(`wss://relay${i}.example.com`) as unknown as Socket; socket.open(); sockets.push(socket); }
    expect(() => new WebSocket("wss://overflow.example.com")).toThrow("budget");
    for (let i = 0; i < 48; i++) sockets[Math.floor(i / 8)].send(JSON.stringify(["REQ", `sub${i}`, {}]));
    expect(() => sockets[6].send(JSON.stringify(["REQ", "overflow", {}]))).toThrow("budget");
    sockets[0].send(JSON.stringify(["CLOSE", "sub0"]));
    sockets[6].send(JSON.stringify(["REQ", "reused", {}]));
    expect(socketUsage.requests).toBe(48);
    for (const socket of sockets) socket.close();
    expect(socketUsage).toEqual({ sockets: 0, connecting: 0, requests: 0 });
});
it.each([
    { name: "oversized text", data: "x".repeat(350000), messages: 1 },
    { name: "unsupported binary", data: new ArrayBuffer(1), messages: 1 },
    { name: "message burst", data: "[]", messages: 201 },
])("closes $name input with a browser-valid code and releases owned subscriptions", async ({ data, messages }) => {
    vi.stubGlobal("WebSocket", Socket);
    const { socketUsage } = await import("./socketBudget");
    const socket = new WebSocket("wss://receive-budget.example.com") as unknown as Socket;
    socket.open(); socket.send(JSON.stringify(["REQ", "owned", {}]));
    const delivered = vi.fn(); socket.addEventListener("message", delivered);
    for (let i = 0; i < messages; i++) socket.dispatchEvent(new MessageEvent("message", { data }));
    expect(socket.readyState).toBe(3);
    expect(delivered).toHaveBeenCalledTimes(messages - 1);
    expect(socketUsage).toEqual({ sockets: 0, connecting: 0, requests: 0 });
});
