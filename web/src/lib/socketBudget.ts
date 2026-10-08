// Installed before application imports so NDK, NWC and remote signers share a
// socket/REQ budget. Exhaustion fails visibly instead of growing hidden queues.
export const socketUsage = { sockets: 0, connecting: 0, requests: 0 };
const relayRequests = new Map<string, number>();
const relaySockets = new Map<string, number>();
const receive = { start: 0, bytes: 0, messages: 0 };
const NativeWebSocket = globalThis.WebSocket;
if (NativeWebSocket) {
    globalThis.WebSocket = class extends NativeWebSocket {
        private requests = new Set<string>();
        private relay: string;
        constructor(url: string | URL, protocols?: string | string[]) {
            const relay = new URL(url).toString();
            if ((relaySockets.get(relay) ?? 0) >= 3 || socketUsage.sockets >= 12 || socketUsage.connecting >= 4) throw new Error("Nostr connection budget exhausted");
            super(url, protocols);
            this.relay = relay; relaySockets.set(relay, (relaySockets.get(relay) ?? 0) + 1);
            socketUsage.sockets++;
            socketUsage.connecting++;
            let connecting = true;
            const opened = () => { if (connecting) { connecting = false; socketUsage.connecting--; } };
            this.addEventListener("open", opened, { once: true });
            this.addEventListener("close", () => {
                opened(); socketUsage.sockets--;
                socketUsage.requests -= this.requests.size;
                relayRequests.set(relay, (relayRequests.get(relay) ?? 0) - this.requests.size);
                if (!relayRequests.get(relay)) relayRequests.delete(relay);
                relaySockets.set(relay, (relaySockets.get(relay) ?? 1) - 1);
                if (!relaySockets.get(relay)) relaySockets.delete(relay);
                this.requests.clear();
            }, { once: true });
            let windowStart = Date.now(), messages = 0, bytes = 0;
            this.addEventListener("message", (event) => {
                if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); messages = 0; bytes = 0; }
                const size = typeof event.data === "string" ? event.data.length * 3 : Infinity;
                bytes += size;
                if (Date.now() - receive.start >= 1000) { receive.start = Date.now(); receive.bytes = 0; receive.messages = 0; }
                receive.bytes += size; receive.messages++;
                if (size > 1_048_576 || ++messages > 200 || bytes > 5_242_880 || receive.bytes > 16_777_216 || receive.messages > 640) {
                    // Browser close() accepts 1000 or application codes 3000-4999.
                    event.stopImmediatePropagation(); this.close(4009, "Nostr receive budget exceeded");
                }
            });
        }
        override send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
            if (typeof data === "string") {
                let message: unknown;
                try { message = JSON.parse(data); } catch { super.send(data); return; }
                if (Array.isArray(message) && typeof message[1] === "string") {
                    const [type, id] = message;
                    if (type === "REQ" && !this.requests.has(id)) {
                        if (this.requests.size >= 8 || (relayRequests.get(this.relay) ?? 0) >= 8 || socketUsage.requests >= 48) throw new Error("Nostr subscription budget exhausted");
                        // Sending can throw. Count only requests actually handed to the socket.
                        super.send(data); this.requests.add(id); socketUsage.requests++; relayRequests.set(this.relay, (relayRequests.get(this.relay) ?? 0) + 1); return;
                    }
                    if (type === "CLOSE" && this.requests.delete(id)) { socketUsage.requests--; relayRequests.set(this.relay, (relayRequests.get(this.relay) ?? 1) - 1); if (!relayRequests.get(this.relay)) relayRequests.delete(this.relay); }
                }
            }
            super.send(data);
        }
    };
}
