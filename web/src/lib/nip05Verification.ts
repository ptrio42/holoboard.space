import { NIP05_REGEX } from "nostr-tools/nip05";
import { withReadBudget } from "./readBudget";

export type Nip05State = "verified" | "mismatch" | "unavailable" | "invalid";
export interface Nip05Result { state: Nip05State; checkedAt: number }

/** Parse the installed identifier form, then enforce NIP-05 name and public-host constraints. */
export function nip05Endpoint(identifier: string): URL | undefined {
    if (identifier.length > 320) return;
    const match = NIP05_REGEX.exec(identifier);
    if (!match) return;
    const [, name = "_", domain] = match;
    if (!/^[a-z0-9_.-]+$/.test(name) || domain.length > 253) return;
    const host = domain.toLowerCase();
    if (/^[\d.]+$/.test(host) || /\.(local|internal|localhost)$/.test(host) ||
        !host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return;
    const url = new URL(`https://${host}/.well-known/nostr.json`);
    url.searchParams.set("name", name);
    return url;
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
    const limit = 65536;
    if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new Error("Response limit"); }
    if (!response.body) throw new Error("Empty response");
    const reader = response.body.getReader();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let bytes = 0;
    try {
        while (true) {
            if (signal.aborted) throw signal.reason;
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > limit) { await reader.cancel(); throw new Error("Response limit"); }
            chunks.push(decoder.decode(next.value, { stream: true }));
        }
        if (signal.aborted) throw signal.reason;
        chunks.push(decoder.decode());
        return JSON.parse(chunks.join(""));
    } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

/** Check a domain-to-key mapping independently of metadata signatures and person identity. */
export async function verifyNip05(pubkey: string, identifier: string, signal?: AbortSignal): Promise<Nip05Result> {
    const endpoint = nip05Endpoint(identifier);
    const result = (state: Nip05State) => ({ state, checkedAt: Date.now() });
    if (!endpoint || !/^[0-9a-f]{64}$/.test(pubkey)) return result("invalid");
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => controller.abort("timeout"), 8000);
    try {
        return await withReadBudget(controller.signal, async () => {
            const response = await fetch(endpoint, { signal: controller.signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
            if (response.status !== 200 || response.redirected) { await response.body?.cancel(); return result("unavailable"); }
            const body = await readBoundedJson(response, controller.signal);
            if (!body || typeof body !== "object" || !("names" in body) || !body.names || typeof body.names !== "object" || Array.isArray(body.names)) return result("unavailable");
            const names = body.names as Record<string, unknown>;
            const name = endpoint.searchParams.get("name")!;
            const key = Object.hasOwn(names, name) ? names[name] : undefined;
            if (key === undefined) return result("mismatch");
            if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)) return result("unavailable");
            return result(key === pubkey ? "verified" : "mismatch");
        });
    } catch {
        if (signal?.aborted) throw signal.reason;
        return result("unavailable");
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}
