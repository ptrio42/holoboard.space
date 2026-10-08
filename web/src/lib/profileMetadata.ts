import type { Event } from "nostr-tools";
import { bech32 } from "@scure/base";

export interface SafeProfile { name?: string; displayName?: string; picture?: string; banner?: string; nip05?: string; about?: string; website?: string; lud16?: string; lud06?: string }
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
        const lud16 = text("lud16"), lud06 = text("lud06");
        let lnurl: string | undefined;
        try {
            if (lud06) {
                const decoded = bech32.decode(lud06 as `${string}1${string}`, 2048);
                if (decoded.prefix === "lnurl" && profileWebsite(new TextDecoder().decode(bech32.fromWords(decoded.words)))) lnurl = lud06;
            }
        } catch { /* Invalid LNURLs remain unavailable, without payment discovery. */ }
        return { name: text("name"), displayName: text("display_name") ?? text("displayName"), about: text("about"), nip05: text("nip05"),
            picture: profileWebsite(picture), banner: profileWebsite(text("banner")), website: profileWebsite(text("website")),
            lud16: lud16 && /^[a-z0-9_.+-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z0-9-]+$/i.test(lud16) ? lud16 : undefined, lud06: lnurl };
    } catch { return; }
}
