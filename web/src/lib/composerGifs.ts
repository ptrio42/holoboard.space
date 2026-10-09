import { mediaUrl, readMediaJson } from "./composerMedia";
export interface ComposerGif { url: string; preview: string; title: string }
export function gifSearchAvailable() {
    return import.meta.env.VITE_ENABLE_GIF_SEARCH === "true" || ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}
export async function searchComposerGifs(query: string, signal: AbortSignal): Promise<ComposerGif[]> {
    if (!gifSearchAvailable()) throw new Error("GIF search is not enabled for this site. Paste a GIF link instead.");
    const url = new URL("https://gifs.nostr.build/api/v1/search");
    url.searchParams.set("q", query.trim().slice(0, 120) || "hello"); url.searchParams.set("limit", "24"); url.searchParams.set("safe", "1");
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]), credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error("GIF search is unavailable. Try again or paste a GIF link.");
    const json = await readMediaJson(response, 131072) as { items?: { url?: string; title?: string; previews?: { w240?: { still?: string } } }[] };
    if (!Array.isArray(json.items)) throw new Error("Invalid GIF search response.");
    return json.items.slice(0, 24).flatMap(item => {
        try {
            const url = mediaUrl(item.url ?? ""), preview = mediaUrl(item.previews?.w240?.still ?? "");
            if (new URL(url).hostname !== "gifs.nostr.build" || new URL(preview).hostname !== "gifs.nostr.build") return [];
            return [{ url, preview, title: (item.title ?? "GIF").slice(0, 160) }];
        } catch { return []; }
    });
}
