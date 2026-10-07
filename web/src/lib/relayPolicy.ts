import { PUBLIC_RELAYS, RELAY_URL } from "../config";

export const DISCOVERY_RELAYS = ["wss://purplepag.es", "wss://nos.lol"];
const configured = new Set([RELAY_URL, ...PUBLIC_RELAYS].map((value) => normalise(value)).filter(Boolean));
function normalise(value: string): string | null {
    try {
        if (value.length > 2048) return null;
        const url = new URL(value);
        if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash) return null;
        if (url.pathname === "/") url.pathname = "";
        return url.toString().replace(/\/$/, "");
    } catch { return null; }
}
export function safeRelay(value: string): string | null {
    const canonical = normalise(value);
    if (!canonical) return null;
    if (configured.has(canonical)) return canonical;
    const url = new URL(canonical);
    if (url.protocol !== "wss:" || (url.port && url.port !== "443")) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    // Browsers cannot pin DNS. Literal IP hints and local hostname forms are
    // rejected; server-side discovery additionally validates resolved IPs.
    if (!host.includes(".") || host.includes(":") || /^[\d.]+$/.test(host) || /\.(local|internal|localhost)$/.test(host)) return null;
    return canonical;
}
export function relayCandidates(values: string[], limit = 12): string[] {
    return [...new Set(values.map(safeRelay).filter((url): url is string => !!url))].slice(0, limit);
}
