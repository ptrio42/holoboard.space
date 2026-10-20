export const TOPICS = ['arts', 'science', 'culture', 'practical', 'community', 'projects', 'personal', 'bitcoin_nostr', 'other'] as const;
export type Topic = typeof TOPICS[number];
export type Reward = 21 | 100 | 500;
export interface Decision {
  note_id: string; selected: boolean; reason: string; topic: Topic;
  language: string; confidence: number; reward_sats: Reward;
}
export interface Payload { run_id: string; batch_id: string; decisions: Decision[] }
export interface Candidate {
  event: { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string };
  source_relays: string[]; first_seen_at: string;
}
export interface Batch {
  prompt_selection?: { available_candidates: number; omitted_candidates: number };
  batch_id: string; candidates: Candidate[];
  policy: {
    daily_discoveries: number; daily_reward_sats: number; reward_tiers: Reward[];
    placement_days: number; author_cooldown_days: number; bitcoin_nostr_window: number;
    minimum_confidence: number; topics: Topic[]; model_rounds_per_day: number;
    review_required?: boolean;
  };
  recent_selections: { note_id: string; author: string; topic: Topic; language: string; created_at: string }[];
  mode: 'dry_run' | 'active' | 'disabled'; completed: boolean;
  collection: { scope: 'partial_public_sample'; [key: string]: unknown };
}
export class SafeError extends Error {
  constructor(code: string) { super(code); this.name = 'SafeError'; }
}
export function object(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function assert(condition: unknown, code = 'invalid_backend_batch'): asserts condition {
  if (!condition) throw new SafeError(code);
}
export function exact(v: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
}
export function isTopic(v: unknown): v is Topic { return TOPICS.includes(v as Topic); }
function shortString(v: unknown, max: number): v is string { return typeof v === 'string' && v.length > 0 && v.length <= max; }
const hex64 = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function parseBatch(v: unknown): Batch {
  assert(object(v));
  assert(shortString(v.batch_id, 200) && ['dry_run', 'active', 'disabled'].includes(String(v.mode)) && typeof v.completed === 'boolean');
  assert(Array.isArray(v.candidates) && v.candidates.length <= 50);
  const ids = new Set<string>();
  for (const c of v.candidates) {
    assert(object(c) && object(c.event));
    const e = c.event;
    assert(hex64(e.id) && hex64(e.pubkey) && typeof e.sig === 'string' && /^[a-f0-9]{128}$/.test(e.sig));
    assert(!ids.has(e.id)); ids.add(e.id);
    assert(Number.isSafeInteger(e.created_at) && Number(e.created_at) > 0 && Number.isSafeInteger(e.kind));
    assert(typeof e.content === 'string' && Array.isArray(e.tags) && e.tags.length <= 2000);
    assert(e.tags.every(t => Array.isArray(t) && t.length <= 100 && t.every(s => typeof s === 'string')));
    assert(Array.isArray(c.source_relays) && c.source_relays.length <= 100 && c.source_relays.every(s => typeof s === 'string'));
    assert(shortString(c.first_seen_at, 100) && Number.isFinite(Date.parse(c.first_seen_at)));
  }
  assert(object(v.policy)); const p = v.policy;
  assert(Number.isSafeInteger(p.daily_discoveries) && Number(p.daily_discoveries) >= 0 && Number(p.daily_discoveries) <= 3);
  assert(Number.isSafeInteger(p.daily_reward_sats) && Number(p.daily_reward_sats) >= 0);
  assert(Array.isArray(p.reward_tiers) && p.reward_tiers.length === 3 && [21, 100, 500].every(t => (p.reward_tiers as unknown[]).includes(t)));
  assert(p.placement_days === 7 && p.author_cooldown_days === 30 && p.bitcoin_nostr_window === 5 && p.model_rounds_per_day === 2);
  assert(p.review_required === undefined || typeof p.review_required === 'boolean');
  assert(typeof p.minimum_confidence === 'number' && p.minimum_confidence >= 0.7 && p.minimum_confidence <= 1);
  assert(Array.isArray(p.topics) && p.topics.length === TOPICS.length && TOPICS.every(t => (p.topics as unknown[]).includes(t)));
  assert(Array.isArray(v.recent_selections) && v.recent_selections.length <= 100);
  for (const r of v.recent_selections) {
    assert(object(r) && hex64(r.note_id) && hex64(r.author) && isTopic(r.topic) && shortString(r.language, 40) && shortString(r.created_at, 100));
  }
  assert(object(v.collection) && v.collection.scope === 'partial_public_sample');
  return v as unknown as Batch;
}
export function parseDecisions(v: unknown, candidateIds?: string[], batch?: Batch): Decision[] {
  const fail = 'invalid_model_decisions';
  assert(object(v) && exact(v, ['decisions']) && Array.isArray(v.decisions), fail);
  assert(v.decisions.length >= 1 && v.decisions.length <= 50, fail);
  const seen = new Set<string>(); let selected = 0; let reward = 0;
  for (const d of v.decisions) {
    assert(object(d) && exact(d, ['note_id', 'selected', 'reason', 'topic', 'language', 'confidence', 'reward_sats']), fail);
    assert(hex64(d.note_id) && !seen.has(d.note_id) && (!candidateIds || candidateIds.includes(d.note_id)), fail);
    seen.add(d.note_id);
    assert(typeof d.selected === 'boolean' && typeof d.reason === 'string' && [...d.reason.trim()].length >= 1 && [...d.reason].length <= 280, fail);
    assert(isTopic(d.topic) && shortString(d.language, 40), fail);
    assert(typeof d.confidence === 'number' && Number.isFinite(d.confidence) && d.confidence >= 0 && d.confidence <= 1, fail);
    assert(typeof d.reward_sats === 'number' && [21, 100, 500].includes(d.reward_sats), fail);
    if (d.selected) {
      selected++; reward += Number(d.reward_sats);
      assert(d.confidence >= (batch?.policy.minimum_confidence ?? 0.7), fail);
    }
  }
  assert(selected <= Math.min(3, batch?.policy.daily_discoveries ?? 3), fail);
  assert(!batch || reward <= batch.policy.daily_reward_sats, fail);
  if (candidateIds) assert(seen.size === candidateIds.length, fail);
  return v.decisions as Decision[];
}
export function validatePayload(v: unknown): Payload {
  assert(object(v) && exact(v, ['run_id', 'batch_id', 'decisions']), 'invalid_saved_payload');
  assert(typeof v.run_id === 'string' && /^[a-f0-9-]{36}$/.test(v.run_id) && shortString(v.batch_id, 200), 'invalid_saved_payload');
  parseDecisions({ decisions: v.decisions });
  return v as unknown as Payload;
}
