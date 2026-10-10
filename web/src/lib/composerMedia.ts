import type { Event, EventTemplate } from "nostr-tools";

export interface ComposerAttachment { url: string; type: string; alt: string; sha256?: string; size?: number }
export const COMPOSER_FILE_LIMIT = 20 * 1024 * 1024;
export const COMPOSER_ATTACHMENT_LIMIT = 8;
export const MEDIA_SERVERS = [
    { id: "primal", name: "Primal", protocol: "blossom", url: "https://blossom.primal.net" },
    { id: "build", name: "nostr.build", protocol: "blossom", url: "https://blossom.nostr.build" },
    { id: "check", name: "nostrcheck.me", protocol: "nip96", url: "https://nostrcheck.me", api: "https://cdn.nostrcheck.me" },
] as const;
export interface MediaServer { name: string; protocol: "blossom" | "nip96"; url: string; api?: string }

/** HTTPS only; custom origins are explicit user choices, never inferred from notes. */
export function mediaUrl(value: string): string {
    const url = new URL(value);
    if (value.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.hash ||
        url.hostname === "localhost" || url.hostname.endsWith(".local") || /^[\d.]+$/.test(url.hostname) || url.hostname.startsWith("[")) {
        throw new Error("Use a public HTTPS media URL without credentials.");
    }
    return url.href;
}
export function attachmentTags(attachments: readonly ComposerAttachment[], content: string): string[][] {
    if (attachments.length > COMPOSER_ATTACHMENT_LIMIT) throw new RangeError("Use at most eight attachments.");
    const destinations = new Set(content.split(/\s+/u));
    return attachments.filter(item => destinations.has(item.url)).map(item => {
        const url = mediaUrl(item.url);
        if (!/^[\w.+-]+\/[\w.+-]+$/.test(item.type) || item.alt.length > 1000 || /[\r\n]/.test(item.alt) ||
            item.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(item.sha256) ||
            item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size < 0)) throw new Error("Invalid attachment metadata.");
        return ["imeta", `url ${url}`, `m ${item.type}`, ...(item.sha256 ? [`x ${item.sha256}`] : []),
            ...(item.size === undefined ? [] : [`size ${item.size}`]), ...(item.alt.trim() ? [`alt ${item.alt.trim()}`] : [])];
    });
}
const authorization = (event: Event, blossom: boolean, serverOrigin?: string) => {
    const raw = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(event))));
    // Primal's deployed decoder still requires padded standard Base64.
    // Keep this origin-specific compatibility rule separate from BUD-11.
    const urlSafe = blossom && serverOrigin !== "https://blossom.primal.net";
    return `Nostr ${urlSafe ? raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : raw}`;
};
export async function readMediaJson(response: Response, maximum = 65536): Promise<unknown> {
    if (!response.ok) throw new Error(response.status === 402 ? "This server requires payment. Choose another server." : `Media server returned HTTP ${response.status}.`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("The media server returned no response.");
    const chunks: Uint8Array[] = []; let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read(); if (done) break;
            length += value.length; if (length > maximum) throw new Error("Media response exceeds its limit."); chunks.push(value);
        }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const joined = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(joined));
}
function transfer(url: string, method: string, body: File | FormData, headers: Record<string, string>, signal: AbortSignal, progress: (value: number) => void): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        const abort = () => request.abort();
        const finish = (error?: Error) => { signal.removeEventListener("abort", abort); if (error) reject(error); };
        request.open(method, url); request.timeout = 120000; request.responseType = "text";
        Object.entries(headers).forEach(([key, value]) => request.setRequestHeader(key, value));
        request.upload.onprogress = event => { if (event.lengthComputable) progress(Math.min(99, Math.round(event.loaded / event.total * 100))); };
        request.onprogress = event => { if (event.loaded > 65536) { finish(new Error("Media response exceeds its limit.")); request.abort(); } };
        request.onerror = () => finish(new Error("Upload did not finish. The file may already be on the server; no reply was published."));
        request.ontimeout = request.onerror;
        request.onabort = () => finish(new Error("Upload stopped. The server may have received the file; no reply was published."));
        request.onload = () => {
            finish();
            if (request.status < 200 || request.status >= 300) { reject(new Error(request.status === 402 ? "This server requires payment. Choose another server." : `Upload returned HTTP ${request.status}.`)); return; }
            try { if (request.responseText.length > 65536) throw new Error("Media response exceeds its limit."); resolve(JSON.parse(request.responseText)); }
            catch { reject(new Error("The server returned an invalid upload response. The file may already be uploaded.")); }
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { finish(new Error("Upload stopped.")); return; }
        request.send(body);
    });
}
/** One explicit upload, no fallback, mirroring, publication or payment. */
let uploadActive = false;
interface Nip96Response { status?: string; processing_url?: unknown; payment_request?: unknown; nip94_event?: { tags?: string[][] } }
const processingError = () => new Error("File processing did not finish. The file may already be on the server; your draft is preserved.");
function processingDelay(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(processingError()); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 2000);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
    });
}
async function finishNip96Processing(result: Nip96Response, endpoint: string, sign: (template: EventTemplate) => Promise<Event>, signal: AbortSignal): Promise<Nip96Response> {
    const requireFree = (response: Nip96Response) => {
        if (typeof response.payment_request === "string" && response.payment_request.trim()) throw new Error("This server requires payment. Choose another server.");
    };
    requireFree(result);
    if (!result.processing_url) return result;
    if (result.status !== "success") throw new Error("File processing failed. Your draft is preserved.");
    if (typeof result.processing_url !== "string") throw new Error("The server returned an invalid processing URL.");
    const url = mediaUrl(result.processing_url);
    if (new URL(url).origin !== new URL(endpoint).origin) throw new Error("The server advertised processing on a different origin. Upload was stopped.");
    for (let attempt = 0; attempt < 8; attempt++) {
        if (signal.aborted) throw processingError();
        // nostrcheck.me consumes HTTP tokens once. Each later read needs a fresh
        // signature; the delay also separates their second-based event IDs.
        const created_at = Math.floor(Date.now() / 1000);
        const auth = await sign({ kind: 27235, created_at, content: "", tags: [["u", url], ["method", "GET"]] });
        if (signal.aborted || Math.floor(Date.now() / 1000) - created_at >= 45) throw processingError();
        const response = await readMediaJson(await fetch(url, { method: "GET", headers: { Authorization: authorization(auth, false) },
            signal, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" })) as Nip96Response;
        if (signal.aborted) throw processingError();
        if (!response || typeof response !== "object") throw new Error("The server returned invalid processing metadata.");
        requireFree(response);
        if (response.processing_url && response.processing_url !== url) throw new Error("The server changed the processing URL. Upload was stopped.");
        if (response.status === "success" && !response.processing_url) return response;
        if (response.status !== "processing" && !(response.status === "success" && response.processing_url === url)) throw new Error("File processing failed. Your draft is preserved.");
        if (attempt < 7) await processingDelay(signal);
    }
    throw processingError();
}
export async function uploadMedia(file: File, server: MediaServer, sign: (template: EventTemplate) => Promise<Event>, signal: AbortSignal, progress: (value: number) => void): Promise<ComposerAttachment> {
    if (uploadActive) throw new Error("Another file upload is already active.");
    uploadActive = true;
    try { return await performUpload(file, server, sign, signal, progress); }
    finally { uploadActive = false; }
}
async function performUpload(file: File, server: MediaServer, sign: (template: EventTemplate) => Promise<Event>, signal: AbortSignal, progress: (value: number) => void): Promise<ComposerAttachment> {
    if (!file.size || file.size > COMPOSER_FILE_LIMIT) throw new Error("Choose a file between 1 byte and 20 MiB.");
    const origin = new URL(mediaUrl(server.url));
    if (origin.pathname !== "/" || origin.search) throw new Error("Use a media server origin without a path or query.");
    const deadline = AbortSignal.timeout(150000);
    const bounded = AbortSignal.any([signal, deadline]);
    const requireActive = () => { if (bounded.aborted) throw new Error("Upload stopped. Your draft is preserved."); };
    requireActive(); progress(0);
    let endpoint = `${origin.origin}/upload`;
    if (server.protocol === "nip96") {
        const config = await readMediaJson(await fetch(`${origin.origin}/.well-known/nostr/nip96.json`, { signal: bounded, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" })) as { api_url?: unknown; plans?: { free?: { max_byte_size?: number } }; content_types?: string[] };
        if (typeof config.api_url !== "string") throw new Error("The server did not advertise an upload API.");
        endpoint = mediaUrl(config.api_url);
        if (!server.api || endpoint !== mediaUrl(server.api)) throw new Error("The server advertised a different API. Upload was stopped.");
        const maximum = config.plans?.free?.max_byte_size;
        if (maximum && file.size > maximum) throw new Error("This file exceeds the server's free upload limit.");
        if (config.content_types && !config.content_types.some(type => type === file.type || type.endsWith("/*") && file.type.startsWith(type.slice(0, -1)))) throw new Error("This server does not support the selected file type.");
    }
    requireActive();
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    requireActive();
    const now = Math.floor(Date.now() / 1000);
    const blossom = server.protocol === "blossom";
    const auth = await sign({ kind: blossom ? 24242 : 27235, created_at: now, content: blossom ? `Upload ${file.name} to ${origin.hostname}` : "",
        tags: blossom ? [["t", "upload"], ["x", hash], ["server", origin.hostname], ["expiration", String(now + 300)]] : [["u", endpoint], ["method", "POST"], ["payload", hash]] });
    requireActive();
    const form = new FormData(); form.append("file", file); form.append("size", String(file.size)); form.append("content_type", file.type || "application/octet-stream");
    const result = await transfer(endpoint, blossom ? "PUT" : "POST", blossom ? file : form,
        { Authorization: authorization(auth, blossom, origin.origin), ...(blossom ? { "Content-Type": file.type || "application/octet-stream", "X-SHA-256": hash } : {}) }, bounded, progress);
    requireActive();
    if (!result || typeof result !== "object") throw new Error("The server did not return file metadata.");
    let attachment: ComposerAttachment;
    if (blossom) {
        const blob = result as { url?: unknown; sha256?: unknown; size?: unknown; type?: unknown };
        if (blob.sha256 !== hash || blob.size !== file.size || typeof blob.url !== "string") throw new Error("The uploaded file's hash or size does not match. The URL was not added.");
        attachment = { url: mediaUrl(blob.url), sha256: hash, size: file.size, type: file.type || "application/octet-stream", alt: "" };
    } else {
        const response = await finishNip96Processing(result as Nip96Response, endpoint, sign, bounded);
        requireActive();
        const tags = response.nip94_event?.tags;
        const tag = (key: string) => tags?.find(value => Array.isArray(value) && value[0] === key)?.[1];
        if (response.status !== "success" || response.processing_url || tag("ox") !== hash || !tag("url")) throw new Error("Upload metadata is incomplete or still processing. Your draft is preserved.");
        attachment = { url: mediaUrl(tag("url")!), type: tag("m") ?? (file.type || "application/octet-stream"), sha256: tag("x"), alt: "" };
    }
    attachmentTags([attachment], attachment.url); progress(100); return attachment;
}
