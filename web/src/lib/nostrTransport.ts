import { verifiedNostrEvent } from "./verifyNostrEvent";
import { matchFilter, type Event, type Filter } from "nostr-tools";
import { relayCandidates } from "./relayPolicy";

export type RelayOutcome = "eose" | "timeout" | "closed" | "error" | "budget" | "cancelled" | "found";
export interface QueryResult {
    events: Event[];
    sources: Record<string, string[]>;
    relays: Record<string, RelayOutcome>;
    complete: boolean;
}
export interface DeliveryOutcome {
    state: "accepted" | "rejected" | "uncertain" | "not-sent";
    detail?: string;
}
interface Reader {
    event: (event: Event) => void;
    eose: () => void;
    closed: (outcome?: RelayOutcome) => void;
    priority: number;
}
interface Connection {
    socket: WebSocket;
    ready: Promise<void>;
    readers: Map<string, Reader>;
    writers: Map<string, (outcome: DeliveryOutcome) => void>;
    idle?: ReturnType<typeof setTimeout>;
    pins: number;
    priority: number;
}
const connections = new Map<string, Connection>();
let serial = 0;
let queries = 0;
let connecting = 0;
let publications = 0;
const pending: (() => void)[] = [];

async function dialSlot(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw signal.reason;
    if (connecting >= 3) {
        if (pending.length >= 32) throw new Error("Nostr dial queue full");
        await new Promise<void>((resolve, reject) => {
            const run = () => { signal.removeEventListener("abort", cancel); connecting++; resolve(); };
            const cancel = () => { const index = pending.indexOf(run); if (index >= 0) pending.splice(index, 1); reject(signal.reason); };
            pending.push(run); signal.addEventListener("abort", cancel, { once: true });
        });
    } else connecting++;
    if (signal.aborted) { connecting--; pending.shift()?.(); throw signal.reason; }
    return () => { connecting--; pending.shift()?.(); };
}
function idleConnection(url: string, connection: Connection) {
    if (connection.readers.size || connection.writers.size || connection.pins || connection.socket.readyState >= 2) return;
    clearTimeout(connection.idle);
    connection.idle = setTimeout(() => {
        if (connection.readers.size || connection.writers.size || connection.pins) return;
        if (connections.get(url) === connection) connections.delete(url);
        connection.socket.close();
    }, 15_000);
}
function waitForConnection(connection: Connection, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const cancelled = () => { signal.removeEventListener("abort", cancelled); reject(signal.reason); };
        signal.addEventListener("abort", cancelled, { once: true });
        connection.ready.then(() => {
            signal.removeEventListener("abort", cancelled); resolve();
        }, (error: unknown) => {
            signal.removeEventListener("abort", cancelled); reject(error);
        });
    });
}
async function connectionFor(url: string, signal: AbortSignal, priority = 0): Promise<Connection> {
    let connection = connections.get(url);
    if (connection) {
        clearTimeout(connection.idle);
        try { await waitForConnection(connection, signal); return connection; }
        finally { idleConnection(url, connection); }
    }
    const release = await dialSlot(signal);
    let physicalDial = false;
    try {
        if (signal.aborted) throw signal.reason;
        connection = connections.get(url);
        if (connection) {
            try { await waitForConnection(connection, signal); return connection; }
            finally { idleConnection(url, connection); }
        }
        if (connections.size >= 8) {
            const idle = [...connections].find(([, value]) => value.readers.size === 0 && value.writers.size === 0 && value.pins === 0 && value.socket.readyState === WebSocket.OPEN);
            const displaced = idle ?? [...connections].find(([, value]) => !value.pins && !value.writers.size &&
                (value.readers.size ? [...value.readers.values()].every((reader) => reader.priority < priority) : value.priority < priority));
            if (!displaced) throw new Error("Nostr read connection budget exhausted");
            for (const reader of displaced[1].readers.values()) reader.closed("budget");
            clearTimeout(displaced[1].idle); connections.delete(displaced[0]); displaced[1].socket.close();
        }
        const socket = new WebSocket(url);
        const readers = new Map<string, Reader>();
        const writers = new Map<string, (outcome: DeliveryOutcome) => void>();
        const ready = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { socket.close(); reject(new Error("Relay connection timed out")); }, 5000);
            socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
            socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("Relay connection closed")); }, { once: true });
            socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Relay connection failed")); }, { once: true });
        });
        // A cancelled reader leaves a shared handshake running. Keep its dial
        // slot until the socket opens or fails, independently of that reader.
        physicalDial = true;
        void ready.then(release, release);
        connection = { socket, readers, writers, ready, pins: 0, priority };
        const created = connection;
        connections.set(url, created);
        socket.addEventListener("close", () => {
            if (connections.get(url) === created) connections.delete(url);
            clearTimeout(created.idle);
            for (const reader of readers.values()) reader.closed();
            readers.clear();
            for (const writer of writers.values()) writer({ state: "uncertain", detail: "Connection closed before acknowledgement." });
            writers.clear();
        });
        socket.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
            if (typeof data !== "string" || data.length > 1_048_576) return;
            try {
                const message: unknown = JSON.parse(data);
                if (!Array.isArray(message) || typeof message[1] !== "string") return;
                if (message[0] === "OK" && typeof message[2] === "boolean" && typeof message[3] === "string") {
                    writers.get(message[1])?.({ state: message[2] ? "accepted" : "rejected", detail: message[3].slice(0, 256) });
                    return;
                }
                const reader = readers.get(message[1]);
                if (!reader) return;
                if (message[0] === "EVENT") reader.event(message[2] as Event);
                if (message[0] === "EOSE") reader.eose();
                if (message[0] === "CLOSED") reader.closed();
            } catch { /* Malformed relay frames cannot enter the application. */ }
        });
        try { await waitForConnection(created, signal); return created; }
        finally { idleConnection(url, created); }
    } finally { if (!physicalDial) release(); }
}

/** Explicit public delivery only. The caller must persist the signed event and
 * destinations first. No automatic signer, retry, routing or read-cache writes.
 */
export async function publishSignedEvent(input: Event, urls: string[], options: {
    signal?: AbortSignal; timeout?: number; onOutcome?: (relay: string, outcome: DeliveryOutcome) => void;
} = {}): Promise<{ id: string; relays: Record<string, DeliveryOutcome> }> {
    if (JSON.stringify(input).length * 3 > 65536) throw new RangeError("Publication exceeds the 64 KiB limit.");
    const event = verifiedNostrEvent(input);
    if (!event || ![1, 1111].includes(event.kind)) throw new TypeError("Public delivery requires a verified note or comment.");
    const candidates = relayCandidates(urls, 12);
    if (!candidates.length || urls.length > 12 || urls.some(url => !relayCandidates([url]).length)) throw new TypeError("Invalid publication destinations.");
    const relays: Record<string, DeliveryOutcome> = {};
    if (publications >= 4) {
        for (const url of candidates) relays[url] = { state: "not-sent", detail: "Publication budget exhausted." };
        return { id: event.id, relays };
    }
    publications++;
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort("timeout"), Math.min(options.timeout ?? 8000, 15000));
    const report = (url: string, outcome: DeliveryOutcome) => {
        relays[url] = outcome;
        try { options.onOutcome?.(url, outcome); } catch { /* Observers cannot strand transport ownership. */ }
    };
    try {
        await Promise.all(candidates.map(async url => {
            let connection: Connection | undefined;
            try {
                connection = await connectionFor(url, controller.signal, 2);
                if (controller.signal.aborted) { report(url, { state: "not-sent", detail: "Cancelled before sending." }); return; }
                const current = connection;
                if (current.writers.has(event.id)) { report(url, { state: "not-sent", detail: "This event is already awaiting acknowledgement." }); return; }
                await new Promise<void>(resolve => {
                    let ended = false, sent = false;
                    const finish = (outcome: DeliveryOutcome) => {
                        if (ended) return;
                        ended = true; controller.signal.removeEventListener("abort", cancelled);
                        current.writers.delete(event.id); report(url, outcome); idleConnection(url, current); resolve();
                    };
                    const cancelled = () => finish({ state: sent ? "uncertain" : "not-sent", detail: controller.signal.reason === "timeout" ? "Acknowledgement deadline exceeded." : "Cancelled." });
                    current.writers.set(event.id, finish);
                    controller.signal.addEventListener("abort", cancelled, { once: true });
                    try { current.socket.send(JSON.stringify(["EVENT", event])); sent = true; }
                    catch { finish({ state: "not-sent", detail: "Could not send the event." }); }
                });
            } catch (failure) {
                report(url, { state: "not-sent", detail: controller.signal.aborted ? "Cancelled before sending." : failure instanceof Error && /budget|queue full/i.test(failure.message) ? "Connection budget exhausted." : "Could not connect to the relay." });
            } finally { if (connection) idleConnection(url, connection); }
        }));
        return { id: event.id, relays };
    } finally { publications--; clearTimeout(timer); controller.abort(); options.signal?.removeEventListener("abort", abort); }
}

/** EOSE describes each queried relay only. A deadline never establishes absence. */
export async function queryNostr(filter: Filter, urls: string[], options: {
    signal?: AbortSignal; timeout?: number; first?: boolean; live?: boolean; priority?: number;
    onEvent?: (event: Event) => void;
} = {}): Promise<QueryResult> {
    const result: QueryResult = { events: [], sources: {}, relays: {}, complete: false };
    const candidates = relayCandidates(urls);
    if (queries >= 16) { for (const url of candidates) result.relays[url] = "budget"; return result; }
    queries++;
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort("timeout"), options.timeout ?? 15_000);
    const seen = new Set<string>();
    let bytes = 0;
    try {
        await Promise.all(candidates.map(async (url) => {
            let connection: Connection | undefined;
            const id = `hb:${++serial}`;
            try {
                connection = await connectionFor(url, controller.signal, options.priority);
                if (controller.signal.aborted) { result.relays[url] = controller.signal.reason === "timeout" ? "timeout" : "cancelled"; return; }
                if (connection.readers.size >= 8) { result.relays[url] = "budget"; return; }
                const current = connection;
                await new Promise<void>((resolve) => {
                    let ended = false;
                    const finish = (outcome: RelayOutcome) => {
                        if (ended) return;
                        ended = true; result.relays[url] = outcome;
                        controller.signal.removeEventListener("abort", cancelled);
                        current.readers.delete(id);
                        if (current.socket.readyState === WebSocket.OPEN) {
                            try { current.socket.send(JSON.stringify(["CLOSE", id])); } catch { /* The connection may have closed. */ }
                        }
                        idleConnection(url, current); resolve();
                    };
                    const cancelled = () => finish(controller.signal.reason === "timeout" ? "timeout" : controller.signal.reason === "found" ? "found" : "cancelled");
                    controller.signal.addEventListener("abort", cancelled, { once: true });
                    current.readers.set(id, {
                        priority: options.priority ?? 0,
                        event: (event) => {
                            // Raw JSON frames must pass cryptographic and filter validation.
                            const verified = verifiedNostrEvent(event);
                            if (!verified || !matchFilter(filter, verified)) return;
                            event = verified;
                            bytes += JSON.stringify(event).length * 3;
                            if (seen.size >= 512 || bytes > 5_242_880) { finish("budget"); return; }
                            result.sources[event.id] = [...new Set([...(result.sources[event.id] ?? []), url])];
                            if (!seen.has(event.id)) {
                                seen.add(event.id); result.events.push(event); options.onEvent?.(event);
                            }
                            if (options.first) controller.abort("found");
                        },
                        eose: () => { if (!options.live) finish("eose"); },
                        closed: (outcome) => finish(outcome ?? "closed"),
                    });
                    try { current.socket.send(JSON.stringify(["REQ", id, filter])); }
                    catch { finish("error"); }
                });
            } catch (error) { result.relays[url] = controller.signal.aborted ? (controller.signal.reason === "timeout" ? "timeout" : "cancelled") : error instanceof Error && /budget|queue full/i.test(error.message) ? "budget" : "error"; }
            finally { if (connection) idleConnection(url, connection); }
        }));
        result.events.sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
        result.complete = candidates.length > 0 && Object.values(result.relays).every((outcome) => outcome === "eose");
        return result;
    } finally {
        queries--; clearTimeout(timer); controller.abort(); options.signal?.removeEventListener("abort", abort);
    }
}

/** Board status uses the same socket as reads, without a duplicate NDK pool. */
export function monitorRelay(url: string, onStatus: (status: "connecting" | "connected" | "offline") => void) {
    const controller = new AbortController();
    let connection: Connection | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    const retry = async () => {
        if (running || controller.signal.aborted || connection?.socket.readyState === WebSocket.OPEN) return;
        running = true; clearTimeout(timer); onStatus("connecting");
        try {
            const canonical = relayCandidates([url])[0];
            if (!canonical) throw new Error("Invalid relay");
            const current = await connectionFor(canonical, controller.signal, 3);
            if (controller.signal.aborted) { idleConnection(canonical, current); return; }
            connection = current; current.pins++; clearTimeout(current.idle);
            onStatus("connected");
            current.socket.addEventListener("close", () => {
                if (connection === current) { current.pins--; connection = undefined; }
                if (!controller.signal.aborted) { onStatus("offline"); timer = setTimeout(() => void retry(), 15_000); }
            }, { once: true });
        } catch {
            if (!controller.signal.aborted) { onStatus("offline"); timer = setTimeout(() => void retry(), 15_000); }
        } finally { running = false; }
    };
    void retry();
    return { retry: () => void retry(), close: () => {
        controller.abort(); clearTimeout(timer);
        if (connection) { connection.pins--; idleConnection(url, connection); connection = undefined; }
    } };
}
