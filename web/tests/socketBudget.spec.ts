import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import type { AddressInfo } from "node:net";

test.use({ serviceWorkers: "block" });
for (const mode of ["oversized frame", "message burst"] as const) test(`native WebSocket closes after ${mode} without losing resource cleanup`, async ({ context, page }) => {
    // Use Vite's real WebSocket server. routeWebSocket replaces the browser API
    // and cannot establish that native close-code validation is respected.
    const relay = await createServer({ configFile: false, appType: "custom", logLevel: "silent",
        server: { host: "127.0.0.1", port: 0 }, optimizeDeps: { noDiscovery: true, include: [] } });
    await relay.listen(0);
    try {
        const port = (relay.httpServer!.address() as AddressInfo).port;
        const origin = new URL(test.info().project.use.baseURL!).origin;
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue()
            : route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ entries: [], targets: [], total: 0, has_more: false, count: 0, note_ids: [] }) }));
        await context.addInitScript(({ appPort, relayPort }) => {
            const Native = window.WebSocket;
            window.WebSocket = class extends Native {
                constructor(url: string | URL, protocols?: string | string[]) {
                    const target = new URL(url);
                    if (target.hostname !== "127.0.0.1" || ![appPort, relayPort].includes(target.port)) throw new Error("Remote socket blocked in native fixture");
                    super(url, protocols);
                }
            };
        }, { appPort: new URL(origin).port, relayPort: String(port) });
        await page.goto("/");
        await page.evaluate(async ({ port, token }) => {
            const modulePath = "/src/lib/socketBudget.ts";
            const { socketUsage } = await import(/* @vite-ignore */ modulePath);
            const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`, "vite-hmr");
            const state = (window as unknown as { nativeBudget: { delivered: number; code?: number; usage: typeof socketUsage } }).nativeBudget = { delivered: 0, usage: socketUsage };
            socket.addEventListener("message", () => state.delivered++);
            socket.addEventListener("close", event => { state.code = event.code; });
            await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("Native fixture socket failed")); });
            socket.send(JSON.stringify(["REQ", "owned-native-read", {}]));
        }, { port, token: relay.config.webSocketToken });
        await expect.poll(() => relay.ws.clients.size).toBe(1);
        // Let the native connection's welcome frame finish before the burst.
        await expect.poll(() => page.evaluate(() => (window as unknown as { nativeBudget: { delivered: number } }).nativeBudget.delivered)).toBeGreaterThan(0);
        if (mode === "oversized frame") relay.ws.send("native:receive-budget", "x".repeat(350000));
        else for (let i = 0; i < 220; i++) relay.ws.send("native:receive-budget", i);
        await expect.poll(() => page.evaluate(() => (window as unknown as { nativeBudget: { code?: number } }).nativeBudget.code)).toBe(4009);
        const result = await page.evaluate(() => (window as unknown as { nativeBudget: { delivered: number; usage: { sockets: number; connecting: number; requests: number } } }).nativeBudget);
        expect(result.usage).toEqual({ sockets: 0, connecting: 0, requests: 0 });
        expect(result.delivered).toBeLessThanOrEqual(mode === "oversized frame" ? 1 : 200);
        expect(errors).toEqual([]);
        await expect.poll(() => relay.ws.clients.size).toBe(0);
    } finally { await relay.close(); }
});
