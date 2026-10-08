import { decode } from "nostr-tools/nip19";
import { eventPointer, pointerRelays, profilePointer } from "./nostrPointers";
const HEX = /^[0-9a-f]{64}$/;
function urlFor(path: string) {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.length > 4096) return null;
    try { const url = new URL(path, "https://holoboard.invalid"); return url.origin === "https://holoboard.invalid" ? url : null; } catch { return null; }
}
function readerIdentity(url: URL) {
    const match = /^\/(discussion|profile)\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) return null;
    const [, screen, pointer] = match;
    let id: string, author: string | undefined, hints: string[] = [];
    if (HEX.test(pointer)) id = pointer;
    else {
        try {
            const decoded = decode(pointer);
            if (screen === "discussion" && decoded.type === "nevent") {
                id = decoded.data.id; author = decoded.data.author; hints = decoded.data.relays ?? [];
            } else if (screen === "profile" && decoded.type === "nprofile") {
                id = decoded.data.pubkey; hints = decoded.data.relays ?? [];
            } else if ((screen === "discussion" && decoded.type === "note") || (screen === "profile" && decoded.type === "npub")) id = decoded.data;
            else return null;
        } catch { return null; }
    }
    if (!HEX.test(id)) return null;
    const legacyAuthor = url.searchParams.get("author");
    author ??= legacyAuthor && HEX.test(legacyAuthor) ? legacyAuthor : undefined;
    return { screen, id, author, hints: pointerRelays([...hints.slice(0, 16), ...url.searchParams.getAll("relay").slice(0, 4)]) };
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
    const identity = readerIdentity(url);
    if (!identity) return boardReturnPath(value);
    const params = new URLSearchParams();
    // Keep the original pointer for history restoration. Embedded hints are
    // filtered by readerIdentity before any read, including on return.
    const pathname = url.pathname.replace(/\/$/, "");
    const author = url.searchParams.get("author");
    if (identity.screen === "discussion" && author && HEX.test(author)) params.set("author", author);
    for (const relay of pointerRelays(url.searchParams.getAll("relay"))) params.append("relay", relay);
    const back = readingReturnPath(url.searchParams.get("from"), depth + 1);
    if (back !== "/") params.set("from", back);
    const href = pathname + (params.size ? `?${params}` : "");
    return href.length <= 4096 ? href : pathname;
}
export function discussionRoute(path: string) {
    const url = urlFor(path), identity = url && readerIdentity(url);
    return url && identity?.screen === "discussion" ? { focusId: identity.id, author: identity.author, hints: identity.hints, from: readingReturnPath(url.searchParams.get("from")) } : null;
}
export function discussionHref(id: string, author?: string, from = "/", hints: string[] = []) {
    if (!HEX.test(id)) throw new TypeError("Invalid discussion ID");
    const params = new URLSearchParams();
    const back = readingReturnPath(from);
    if (back !== "/") params.set("from", back);
    const pathname = `/discussion/${eventPointer(id, author, hints)}`;
    const href = pathname + (params.size ? `?${params}` : "");
    return href.length <= 4096 ? href : pathname;
}
export function profileRoute(path: string) {
    const url = urlFor(path), identity = url && readerIdentity(url);
    return url && identity?.screen === "profile" ? { pubkey: identity.id, hints: identity.hints, from: readingReturnPath(url.searchParams.get("from")) } : null;
}
export function profileHref(pubkey: string, from = "/", hints: string[] = []) {
    if (!HEX.test(pubkey)) throw new TypeError("Invalid profile key");
    const params = new URLSearchParams();
    const back = readingReturnPath(from);
    if (back !== "/") params.set("from", back);
    const pathname = `/profile/${profilePointer(pubkey, hints)}`;
    const href = pathname + (params.size ? `?${params}` : "");
    return href.length <= 4096 ? href : pathname;
}
export function readingBackLabel(from: string) {
    return from.startsWith("/discussion/") ? "Back to discussion" : from.startsWith("/profile/") ? "Back to profile" : "Back to board";
}
