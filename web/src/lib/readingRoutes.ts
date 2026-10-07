import { relayCandidates } from "./relayPolicy";
const HEX = /^[0-9a-f]{64}$/;
function urlFor(path: string) {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.length > 4096) return null;
    try { const url = new URL(path, "https://holoboard.invalid"); return url.origin === "https://holoboard.invalid" ? url : null; } catch { return null; }
}
export function boardReturnPath(value: string | null): string {
    if (!value) return "/";
    const [path, query = ""] = value.split("?");
    if (path !== "/" && path !== "/waiting" && path !== "/expired") return "/";
    const view = new URLSearchParams(query).get("view");
    return path === "/waiting" && ["top", "new", "hot"].includes(view ?? "") ? `${path}?view=${view}` : path;
}
/** Return links can contain two reader levels, never arbitrary destinations. */
export function readingReturnPath(value: string | null, depth = 0): string {
    if (!value || depth >= 2) return boardReturnPath(value);
    const url = urlFor(value);
    if (!url) return "/";
    if (!/^\/(discussion|profile)\/[0-9a-f]{64}\/?$/.test(url.pathname)) return boardReturnPath(value);
    const params = new URLSearchParams();
    const author = url.searchParams.get("author");
    if (url.pathname.startsWith("/discussion/") && author && HEX.test(author)) params.set("author", author);
    if (url.pathname.startsWith("/profile/")) for (const relay of relayCandidates(url.searchParams.getAll("relay").slice(0, 4), 4)) params.append("relay", relay);
    const back = readingReturnPath(url.searchParams.get("from"), depth + 1);
    if (back !== "/") params.set("from", back);
    return url.pathname.replace(/\/$/, "") + (params.size ? `?${params}` : "");
}
export function discussionRoute(path: string) {
    const url = urlFor(path), match = url && /^\/discussion\/([0-9a-f]{64})\/?$/.exec(url.pathname);
    if (!url || !match) return null;
    const author = url.searchParams.get("author");
    return { focusId: match[1], author: author && HEX.test(author) ? author : undefined, from: readingReturnPath(url.searchParams.get("from")) };
}
export function discussionHref(id: string, author?: string, from = "/") {
    if (!HEX.test(id)) throw new TypeError("Invalid discussion ID");
    const params = new URLSearchParams();
    if (author && HEX.test(author)) params.set("author", author);
    const back = readingReturnPath(from);
    if (back !== "/") params.set("from", back);
    const href = `/discussion/${id}${params.size ? `?${params}` : ""}`;
    return href.length <= 4096 ? href : `/discussion/${id}`;
}
export function profileRoute(path: string) {
    const url = urlFor(path), match = url && /^\/profile\/([0-9a-f]{64})\/?$/.exec(url.pathname);
    return url && match ? { pubkey: match[1], hints: relayCandidates(url.searchParams.getAll("relay").slice(0, 4), 4), from: readingReturnPath(url.searchParams.get("from")) } : null;
}
export function profileHref(pubkey: string, from = "/", hints: string[] = []) {
    if (!HEX.test(pubkey)) throw new TypeError("Invalid profile key");
    const params = new URLSearchParams();
    for (const relay of relayCandidates(hints.slice(0, 4), 4)) params.append("relay", relay);
    const back = readingReturnPath(from);
    if (back !== "/") params.set("from", back);
    const href = `/profile/${pubkey}${params.size ? `?${params}` : ""}`;
    return href.length <= 4096 ? href : `/profile/${pubkey}`;
}
export function readingBackLabel(from: string) {
    return from.startsWith("/discussion/") ? "Back to discussion" : from.startsWith("/profile/") ? "Back to profile" : "Back to board";
}
