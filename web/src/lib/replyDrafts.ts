const KEY = "holoboard-reply-drafts-v1";
const HEX = /^[0-9a-f]{64}$/;
const bytes = (value: string) => new TextEncoder().encode(value).length;
function load(): Record<string, string> {
    const raw = sessionStorage.getItem(KEY) ?? "{}";
    if (raw.length > 524288) throw new Error("Reply draft storage exceeds its limit.");
    const value: unknown = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Invalid reply draft storage.");
    const entries = Object.entries(value);
    if (entries.length > 8 || entries.some(([id, text]) => !HEX.test(id) || typeof text !== "string" || bytes(text) > 16384)) throw new Error("Invalid reply draft storage.");
    return Object.fromEntries(entries);
}
export function readReplyDraft(parentId: string): { text: string; saved: boolean } {
    try { return { text: load()[parentId] ?? "", saved: true }; }
    catch { return { text: "", saved: false }; }
}
/** Never evict another draft or touch signer, wallet or invoice storage. */
export function saveReplyDraft(parentId: string, text: string): boolean {
    try {
        if (!HEX.test(parentId) || bytes(text) > 16384) return false;
        const drafts = load();
        if (text) drafts[parentId] = text; else delete drafts[parentId];
        if (Object.keys(drafts).length > 8) return false;
        sessionStorage.setItem(KEY, JSON.stringify(drafts)); return true;
    } catch { return false; }
}
