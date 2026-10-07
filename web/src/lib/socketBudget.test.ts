import { afterEach, expect, it, vi } from "vitest";

class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    send(data: unknown) { void data; }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
    open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
}
afterEach(() => vi.unstubAllGlobals());
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
