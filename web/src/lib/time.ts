const UNITS: [limit: number, seconds: number, suffix: string][] = [
    [60, 1, "s"],
    [3_600, 60, "m"],
    [86_400, 3_600, "h"],
    [2_592_000, 86_400, "d"],
    [31_536_000, 2_592_000, "mo"],
    [Number.POSITIVE_INFINITY, 31_536_000, "y"],
];

/** Compact age of a nostr timestamp: 5m, 3h, 12d. */
export function timeAgo(unixSeconds: number, now = Date.now()): string {
    const elapsed = Math.max(0, Math.floor(now / 1_000) - unixSeconds);
    for (const [limit, seconds, suffix] of UNITS) {
        if (elapsed < limit) return `${Math.max(1, Math.floor(elapsed / seconds))}${suffix}`;
    }
    return "";
}

export function isoDate(unixSeconds: number): string {
    return new Date(unixSeconds * 1_000).toISOString();
}
