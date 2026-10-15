/** Temporary media entries are replaced when a Holoboard route supersedes them. */
export const MEDIA_VIEWER_ENTRY = "holoboardMediaViewer";
export function isMediaViewerEntry(state: unknown): boolean {
    if (!state || typeof state !== "object") return false;
    const token = (state as Record<string, unknown>)[MEDIA_VIEWER_ENTRY];
    return typeof token === "string" && /^[a-f0-9-]{36}$/.test(token);
}
