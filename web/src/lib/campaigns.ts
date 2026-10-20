import type { NDKRawEvent } from "@nostr-dev-kit/ndk";
import { SATS_ENDPOINT } from "../config";
import { parseBillboard, type BillboardConfig } from "./billboard";
import type { RankingTarget } from "./ranking";

export type CampaignView = "board" | "top" | "new" | "hot";
export type DiscoveryRewardStatus = "pending" | "preparing" | "sending" | "uncertain" | "paid" | "failed" | "unavailable";
export interface DiscoveryMetadata {
    reason: string; topic: string; language: string; expiresAt: number;
    rewardSats: number; rewardStatus: DiscoveryRewardStatus;
}
export interface CampaignEntry {
    id: string; event: NDKRawEvent; rank: number; weight: number; satsPaid: number;
    firstPaidAt: number; hotSats: number; authorShare: number; billboard?: BillboardConfig;
    entryType?: "promotion"; firstVisibleAt?: number; discovery?: DiscoveryMetadata;
}
export interface DiscoveryEntry {
    id: string; event: NDKRawEvent; entryType: "discovery"; firstVisibleAt: number; discovery: DiscoveryMetadata;
    rank?: never; weight?: never; satsPaid?: never; firstPaidAt?: never; hotSats?: never; authorShare?: never; billboard?: never;
}
export type WaitingEntry = CampaignEntry | DiscoveryEntry;
export interface CampaignPage<T extends WaitingEntry = CampaignEntry> {
    entries: T[]; targets: RankingTarget[]; total: number; activePosts: number; hasMore: boolean; checkedAt?: number; waitingPosts?: number;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const positiveTimestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const rewardStatuses = new Set<string>(["pending", "preparing", "sending", "uncertain", "paid", "failed", "unavailable"]);
function parseDiscovery(value: unknown): DiscoveryMetadata | undefined {
    if (value === undefined) return;
    if (!record(value) || typeof value.reason !== "string" || !value.reason.trim() || [...value.reason].length > 280 ||
        typeof value.topic !== "string" || typeof value.language !== "string" || !positiveTimestamp(value.expires_at) ||
        ![21, 100, 500].includes(Number(value.reward_sats)) || typeof value.reward_sats !== "number" ||
        typeof value.reward_status !== "string" || !rewardStatuses.has(value.reward_status)) throw new Error("Incomplete discovery metadata.");
    return { reason: value.reason, topic: value.topic, language: value.language, expiresAt: value.expires_at,
        rewardSats: value.reward_sats, rewardStatus: value.reward_status as DiscoveryRewardStatus };
}
export function fetchCampaigns(view: CampaignView, page?: number, signal?: AbortSignal): Promise<CampaignPage>;
export function fetchCampaigns(view: CampaignView, page: number, signal: AbortSignal | undefined, includeDiscoveries: true): Promise<CampaignPage<WaitingEntry>>;
export async function fetchCampaigns(view: CampaignView, page = 1, signal?: AbortSignal, includeDiscoveries = false): Promise<CampaignPage<WaitingEntry>> {
    const response = await fetch(`${SATS_ENDPOINT.replace(/\/+$/, "")}/campaigns?view=${view}&page=${page}${includeDiscoveries ? "&include_discoveries=true" : ""}`, { signal });
    if (!response.ok) throw new Error("Could not load campaigns. Try again.");
    const data: unknown = await response.json();
    if (!record(data) || !Array.isArray(data.entries) || !Array.isArray(data.targets)) throw new Error("Incomplete campaign response.");
    const entries = data.entries.map((item: unknown): WaitingEntry => {
        if (includeDiscoveries && record(item) && item.entry_type === "discovery") {
            const discovery = parseDiscovery(item.discovery);
            if (view !== "new" || !record(item.event) || typeof item.id !== "string" || item.id !== item.event.id || !/^[0-9a-f]{64}$/.test(item.id) ||
                !discovery || !positiveTimestamp(item.first_visible_at) || "rank" in item || "weight" in item || "sats_paid" in item) throw new Error("Incomplete discovery entry.");
            return { id: item.id, event: item.event as unknown as NDKRawEvent, entryType: "discovery", firstVisibleAt: item.first_visible_at, discovery };
        }
        if (!record(item) || !record(item.event) || typeof item.event.id !== "string" || typeof item.rank !== "number" || typeof item.weight !== "number" || typeof item.sats_paid !== "number") throw new Error("Incomplete campaign entry.");
        return { id: String(item.id), event: item.event as unknown as NDKRawEvent, rank: item.rank, weight: item.weight, satsPaid: item.sats_paid,
            firstPaidAt: Number(item.first_paid_at), hotSats: Number(item.hot_sats), authorShare: Number(item.author_share ?? 20), billboard: parseBillboard(item.billboard),
            ...(includeDiscoveries ? { entryType: "promotion" as const, firstVisibleAt: positiveTimestamp(item.first_visible_at) ? item.first_visible_at : Number(item.first_paid_at), discovery: parseDiscovery(item.discovery) } : {}) };
    });
    const targets = data.targets.flatMap((item: unknown) => record(item) && typeof item.rank === "number" && typeof item.weight === "number" ? [{ rank: item.rank, weight: item.weight }] : []);
    return { entries, targets, total: Number(data.total), activePosts: Number(data.active_posts), hasMore: data.has_more === true, checkedAt: positiveTimestamp(data.checked_at) ? data.checked_at : undefined,
        waitingPosts: typeof data.waiting_posts === "number" && Number.isSafeInteger(data.waiting_posts) && data.waiting_posts >= 0 ? data.waiting_posts : undefined };
}
