import type { NDKRawEvent } from "@nostr-dev-kit/ndk";
import { SATS_ENDPOINT } from "../config";
import { parseBillboard, type BillboardConfig } from "./billboard";
import type { RankingTarget } from "./ranking";

export type CampaignView = "board" | "top" | "new" | "hot";
export interface CampaignEntry {
    id: string; event: NDKRawEvent; rank: number; weight: number; satsPaid: number;
    firstPaidAt: number; hotSats: number; authorShare: number; billboard?: BillboardConfig;
}
export interface CampaignPage {
    entries: CampaignEntry[]; targets: RankingTarget[]; total: number; activePosts: number; hasMore: boolean;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
export async function fetchCampaigns(view: CampaignView, page = 1, signal?: AbortSignal): Promise<CampaignPage> {
    const response = await fetch(`${SATS_ENDPOINT.replace(/\/+$/, "")}/campaigns?view=${view}&page=${page}`, { signal });
    if (!response.ok) throw new Error("Could not load campaigns. Try again.");
    const data: unknown = await response.json();
    if (!record(data) || !Array.isArray(data.entries) || !Array.isArray(data.targets)) throw new Error("Incomplete campaign response.");
    const entries = data.entries.map((item: unknown): CampaignEntry => {
        if (!record(item) || !record(item.event) || typeof item.event.id !== "string" || typeof item.rank !== "number" || typeof item.weight !== "number" || typeof item.sats_paid !== "number") throw new Error("Incomplete campaign entry.");
        return { id: String(item.id), event: item.event as unknown as NDKRawEvent, rank: item.rank, weight: item.weight, satsPaid: item.sats_paid,
            firstPaidAt: Number(item.first_paid_at), hotSats: Number(item.hot_sats), authorShare: Number(item.author_share ?? 20), billboard: parseBillboard(item.billboard) };
    });
    const targets = data.targets.flatMap((item: unknown) => record(item) && typeof item.rank === "number" && typeof item.weight === "number" ? [{ rank: item.rank, weight: item.weight }] : []);
    return { entries, targets, total: Number(data.total), activePosts: Number(data.active_posts), hasMore: data.has_more === true };
}
