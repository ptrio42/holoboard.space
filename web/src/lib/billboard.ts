import { nip19 } from "@nostr-dev-kit/ndk";

export const BILLBOARD_TEMPLATES = [
    { id: "led", name: "LED ticker", caption: "Text travelling across the screen", sample: "CITY SIGNAL >" },
    { id: "neon", name: "Neon sign", caption: "Bright lettering with a soft glow", sample: "NIGHT CITY" },
    { id: "image-led", name: "Image + LED", caption: "Your note's image above a ticker", sample: "SIGNAL >" },
    { id: "terminal", name: "Terminal", caption: "A message typed onto a terminal", sample: "> HELLO_" },
    { id: "split-flap", name: "Split-flap", caption: "Letters flipping into place", sample: "ARRIVAL" },
    { id: "glitch", name: "Glitch", caption: "A clear message with brief interference", sample: "TRANSMIT" },
    { id: "poster", name: "Poster", caption: "A static headline with an optional image", sample: "YOUR SIGNAL" },
    { id: "slides", name: "Slides", caption: "Up to three fragments in sequence", sample: "01 / 03" },
] as const;

export interface BillboardConfig {
    template: typeof BILLBOARD_TEMPLATES[number]["id"];
    color: "cyan" | "pink" | "gold";
    size: "small" | "medium" | "large";
    speed: "slow" | "normal" | "fast";
    // For slides, text is the first fragment so clients can show a fallback.
    text: string;
    slides?: string[];
    image?: string;
}

export const BILLBOARD_MAX_TEXT = 160;
export const BILLBOARD_MAX_SLIDES = 3;
export const BILLBOARD_COLORS = { cyan: "#22d3ee", pink: "#ec4899", gold: "#fbbf24" };

const NOSTR_SUFFIX = /(?:nostr:)?(?:npub1|nprofile1|note1|nevent1|naddr1)[023456789acdefghjklmnpqrstuvwxyz]+$/i;
const BECH32_CONTINUATION = /^[023456789acdefghjklmnpqrstuvwxyz]+/i;

function validNostrReference(value: string): boolean {
    try {
        nip19.decode(value.replace(/^nostr:/i, ""));
        return true;
    } catch {
        return false;
    }
}

/** Restore a Nostr URI cut at the display limit from the signed source note. */
export function completeNostrReference(fragment: string, content: string): string {
    const suffix = NOSTR_SUFFIX.exec(fragment)?.[0];
    if (!suffix || validNostrReference(suffix)) return fragment;

    let occurrence = content.indexOf(fragment);
    while (occurrence >= 0) {
        const continuation = BECH32_CONTINUATION.exec(content.slice(occurrence + fragment.length))?.[0] ?? "";
        if (continuation && validNostrReference(`${suffix}${continuation}`)) return `${fragment}${continuation}`;
        occurrence = content.indexOf(fragment, occurrence + 1);
    }
    return fragment;
}

export function billboardFragments(config: BillboardConfig): string[] {
    return config.template === "slides" ? config.slides ?? [] : [config.text];
}

export function billboardCharacterCount(config: BillboardConfig): number {
    return billboardFragments(config).reduce((count, fragment) => count + Array.from(fragment).length, 0);
}

export function parseBillboard(value: unknown): BillboardConfig | undefined {
    if (!value || typeof value !== "object") return undefined;
    const b = value as Record<string, unknown>;
    if (!BILLBOARD_TEMPLATES.some(({ id }) => id === b.template) ||
        !["cyan", "pink", "gold"].includes(String(b.color)) ||
        !["small", "medium", "large"].includes(String(b.size)) ||
        !["slow", "normal", "fast"].includes(String(b.speed)) ||
        typeof b.text !== "string" || !b.text.trim() || Array.from(b.text).length > BILLBOARD_MAX_TEXT) return undefined;
    let slides: string[] | undefined;
    if (b.template === "slides") {
        if (!Array.isArray(b.slides) || b.slides.length < 1 || b.slides.length > BILLBOARD_MAX_SLIDES ||
            b.slides.some(text => typeof text !== "string" || !text.trim()) || b.text !== b.slides[0]) return undefined;
        slides = [...b.slides] as string[];
        if (slides.reduce((count, text) => count + Array.from(text).length, 0) > BILLBOARD_MAX_TEXT) return undefined;
    } else if (b.slides !== undefined) return undefined;
    if (b.template === "image-led" || (b.template === "poster" && b.image !== undefined)) {
        if (typeof b.image !== "string" || !/^https?:\/\//i.test(b.image)) return undefined;
    } else if (b.image !== undefined) return undefined;
    return {
        template: b.template as BillboardConfig["template"], color: b.color as BillboardConfig["color"],
        size: b.size as BillboardConfig["size"], speed: b.speed as BillboardConfig["speed"], text: b.text,
        ...(slides ? { slides } : {}), ...(typeof b.image === "string" ? { image: b.image } : {}),
    };
}

export function validBillboard(config: BillboardConfig, content: string, images: string[]): boolean {
    return !!parseBillboard(config) && billboardFragments(config).every(text => content.includes(text)) &&
        (!config.image || images.includes(config.image));
}

export function initialBillboard(content: string): BillboardConfig {
    return { template: "led", color: "cyan", size: "medium", speed: "normal",
        text: Array.from(content).slice(0, BILLBOARD_MAX_TEXT).join("") };
}
