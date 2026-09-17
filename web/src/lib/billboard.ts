export interface BillboardConfig {
    template: "led" | "neon" | "image-led";
    color: "cyan" | "pink" | "gold";
    size: "small" | "medium" | "large";
    speed: "slow" | "normal" | "fast";
    text: string;
    image?: string;
}

export const BILLBOARD_MAX_TEXT = 160;
export const BILLBOARD_COLORS = { cyan: "#22d3ee", pink: "#ec4899", gold: "#fbbf24" };

export function parseBillboard(value: unknown): BillboardConfig | undefined {
    if (!value || typeof value !== "object") return undefined;
    const b = value as Record<string, unknown>;
    if (!["led", "neon", "image-led"].includes(String(b.template)) ||
        !["cyan", "pink", "gold"].includes(String(b.color)) ||
        !["small", "medium", "large"].includes(String(b.size)) ||
        !["slow", "normal", "fast"].includes(String(b.speed)) ||
        typeof b.text !== "string" || !b.text.trim() || Array.from(b.text).length > BILLBOARD_MAX_TEXT) return undefined;
    if (b.template === "image-led" && (typeof b.image !== "string" || !/^https?:\/\//i.test(b.image))) return undefined;
    return {
        template: b.template as BillboardConfig["template"], color: b.color as BillboardConfig["color"],
        size: b.size as BillboardConfig["size"], speed: b.speed as BillboardConfig["speed"], text: b.text,
        ...(b.template === "image-led" ? { image: b.image as string } : {}),
    };
}

export function validBillboard(config: BillboardConfig, content: string, images: string[]): boolean {
    return !!parseBillboard(config) && content.includes(config.text) &&
        (config.template !== "image-led" || images.includes(config.image ?? ""));
}

export function initialBillboard(content: string): BillboardConfig {
    return { template: "led", color: "cyan", size: "medium", speed: "normal",
        text: Array.from(content).slice(0, BILLBOARD_MAX_TEXT).join("") };
}
