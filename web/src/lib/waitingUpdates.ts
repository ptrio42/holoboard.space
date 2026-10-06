import { SATS_ENDPOINT } from "../config";

export const waitingVisitKey = `holoboard-waiting-visit:${SATS_ENDPOINT.replace(/\/+$/, "")}`;
let memoryCheckpoint: number | null = null;
export function readWaitingVisit(): number | null {
    try {
        const value = localStorage.getItem(waitingVisitKey);
        const parsed = value === null ? NaN : Number(value);
        if (Number.isSafeInteger(parsed) && parsed > 0) memoryCheckpoint = Math.max(memoryCheckpoint ?? 0, parsed);
    } catch { /* Keep a checkpoint in memory when persistent storage is blocked. */ }
    return memoryCheckpoint;
}
export function saveWaitingVisit(value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0) return;
    const checkpoint = Math.max(readWaitingVisit() ?? 0, value);
    memoryCheckpoint = checkpoint;
    try { localStorage.setItem(waitingVisitKey, String(checkpoint)); } catch { /* Memory still tracks this visit. */ }
}
export interface WaitingUpdates { count: number; noteIds: string[]; checkedAt: number }
export async function fetchWaitingUpdates(since: number | null, signal: AbortSignal): Promise<WaitingUpdates> {
    const response = await fetch(`${SATS_ENDPOINT.replace(/\/+$/, "")}/waiting-updates${since === null ? "" : `?since=${since}`}`, { signal });
    if (!response.ok) throw new Error("Could not check new waiting-room notes.");
    const data: unknown = await response.json();
    if (typeof data !== "object" || data === null || !("count" in data) || !Number.isSafeInteger(data.count) || Number(data.count) < 0 ||
        !("checked_at" in data) || !Number.isSafeInteger(data.checked_at) || Number(data.checked_at) <= 0 ||
        !("note_ids" in data) || !Array.isArray(data.note_ids) || !data.note_ids.every((id) => typeof id === "string" && /^[0-9a-f]{64}$/.test(id)) || data.count !== data.note_ids.length) {
        throw new Error("Incomplete waiting-room update response.");
    }
    return { count: Number(data.count), noteIds: data.note_ids, checkedAt: Number(data.checked_at) };
}
