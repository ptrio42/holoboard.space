import { attachmentTags, type ComposerAttachment } from "./composerMedia";
const KEY = "holoboard-reply-drafts-v1";
const MEDIA_KEY = "holoboard-reply-media-v1";
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
function loadMedia(): Record<string, ComposerAttachment[]> {
    const raw = sessionStorage.getItem(MEDIA_KEY) ?? "{}";
    if (raw.length > 262144) throw new Error("Attachment drafts exceed their limit.");
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid attachment drafts.");
    const entries = Object.entries(value);
    if (entries.length > 8) throw new Error("Too many attachment drafts.");
    for (const [id, items] of entries) {
        if (!HEX.test(id) || !Array.isArray(items)) throw new Error("Invalid attachment draft.");
        attachmentTags(items, items.map(item => item.url).join("\n"));
    }
    return value as Record<string, ComposerAttachment[]>;
}
export function readReplyAttachments(parentId: string): { attachments: ComposerAttachment[]; saved: boolean } {
    try { return { attachments: loadMedia()[parentId] ?? [], saved: true }; }
    catch { return { attachments: [], saved: false }; }
}
/** Separate metadata storage keeps earlier text drafts and rollback readable. */
export function saveReplyAttachments(parentId: string, attachments: ComposerAttachment[]): boolean {
    try {
        if (!HEX.test(parentId)) return false;
        attachmentTags(attachments, attachments.map(item => item.url).join("\n"));
        const drafts = loadMedia();
        if (attachments.length) drafts[parentId] = attachments; else delete drafts[parentId];
        if (Object.keys(drafts).length > 8) return false;
        sessionStorage.setItem(MEDIA_KEY, JSON.stringify(drafts)); return true;
    } catch { return false; }
}
