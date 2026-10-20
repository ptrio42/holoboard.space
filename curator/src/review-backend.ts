import { Backend } from './backend.ts';
import { SafeError, object } from './contract.ts';

export interface ReviewItem {
  note_id: string; review_id: string;
  event: { id: string; pubkey: string; content: string };
  reason: string; topic: string; language: string; reward_sats: number;
  created_at: string; expires_at: string; dry_run: boolean; published: boolean;
}
export interface ReviewSnapshot {
  mode: 'disabled' | 'dry_run' | 'active'; review_required: boolean; spending_allowed: boolean;
  daily_reward_sats: number; daily_discoveries: number; pending_count: number; offset: number; items: ReviewItem[];
}
export type ReviewAction = { action: 'set_review'; review_required: boolean }
  | { action: 'approve'; note_id: string; review_id: string; reward_sats: number }
  | { action: 'reject'; note_id: string; review_id: string };
export interface ReviewClient {
  snapshot(offset?: number): Promise<ReviewSnapshot>;
  act(action: ReviewAction): Promise<unknown>;
}

export function parseReviewSnapshot(raw: unknown): ReviewSnapshot {
  const fail = (): never => { throw new SafeError('invalid_review_snapshot'); };
  if (!object(raw) || !['disabled', 'dry_run', 'active'].includes(String(raw.mode)) || typeof raw.review_required !== 'boolean'
    || typeof raw.spending_allowed !== 'boolean' || !Number.isSafeInteger(raw.pending_count) || Number(raw.pending_count) < 0
    || !Number.isSafeInteger(raw.offset) || Number(raw.offset) < 0 || !Number.isSafeInteger(raw.daily_reward_sats)
    || !Number.isSafeInteger(raw.daily_discoveries) || !Array.isArray(raw.items) || raw.items.length > 21) fail();
  const data = raw as Record<string, unknown>;
  for (const value of data.items as unknown[]) {
    if (!object(value)) fail();
    const item = value as Record<string, unknown>;
    if (!object(item.event)) fail();
    const event = item.event as Record<string, unknown>;
    if (!/^[a-f0-9]{64}$/.test(String(item.note_id)) || !/^[a-f0-9]{64}$/.test(String(item.review_id))
      || event.id !== item.note_id || !/^[a-f0-9]{64}$/.test(String(event.pubkey)) || typeof event.content !== 'string'
      || Buffer.byteLength(event.content) > 65536 || typeof item.reason !== 'string' || typeof item.topic !== 'string'
      || typeof item.language !== 'string' || typeof item.created_at !== 'string' || typeof item.expires_at !== 'string'
      || typeof item.dry_run !== 'boolean' || typeof item.published !== 'boolean' || typeof item.reward_sats !== 'number' || ![21, 100, 500].includes(item.reward_sats)) fail();
  }
  return raw as unknown as ReviewSnapshot;
}

export class ReviewBackend extends Backend implements ReviewClient {
  async snapshot(offset = 0): Promise<ReviewSnapshot> {
    return parseReviewSnapshot(await this.request('/api/admin/curator/review?offset=' + offset));
  }
  async act(action: ReviewAction): Promise<unknown> {
    return this.request('/api/admin/curator/review', action);
  }
}
