import type { Event } from "nostr-tools";

export interface SafeProfile { name?: string; displayName?: string; picture?: string; nip05?: string; about?: string; website?: string }
export function profileWebsite(value?: string): string | undefined {
    if (!value || [...value].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) return;
    try {
        const url = new URL(value);
        if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
    } catch { /* Unsupported addresses remain plain profile data. */ }
}
export function profileMetadata(event?: Pick<Event, "content">): SafeProfile | undefined {
    if (!event) return;
    try {
        const metadata: unknown = JSON.parse(event.content);
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return;
        const data = metadata as Record<string, unknown>;
        const text = (key: string) => typeof data[key] === "string" ? data[key].trim().slice(0, 2048) : undefined;
        const picture = text("picture");
        return { name: text("name"), displayName: text("display_name") ?? text("displayName"), about: text("about"), nip05: text("nip05"),
            picture: profileWebsite(picture), website: profileWebsite(text("website")) };
    } catch { return; }
}
