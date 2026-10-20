import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { Batch, Decision } from '../src/contract.ts';
import { TOPICS } from '../src/contract.ts';
import type { RpcMessage, ProcessTransport } from '../src/rpc.ts';
import { DISABLED_FEATURES } from '../src/codex.ts';
import type { ProcessFactory } from '../src/codex.ts';
import { join } from 'node:path';

export const noteId = (n = 1): string => n.toString(16).padStart(64, '0');
export function batch(n = 1): Batch {
  return {
    batch_id: 'test-batch', candidates: Array.from({ length: n }, (_, i) => ({
      event: { id: noteId(i + 1), pubkey: noteId(i + 100), created_at: 1_800_000_000, kind: 1, content: 'A practical original account of a small community project.', tags: [], sig: 'a'.repeat(128) },
      source_relays: ['wss://relay.example'], first_seen_at: '2026-10-18T09:00:00Z',
    })),
    policy: { daily_discoveries: 3, daily_reward_sats: 1000, reward_tiers: [21, 100, 500], placement_days: 7, author_cooldown_days: 30, bitcoin_nostr_window: 5, minimum_confidence: 0.7, topics: [...TOPICS], model_rounds_per_day: 2 },
    recent_selections: [], mode: 'dry_run', completed: false, collection: { scope: 'partial_public_sample' },
  };
}
export function decisions(b = batch()): Decision[] {
  return b.candidates.map(c => ({ note_id: c.event.id, selected: true, reason: 'A useful, concrete account of an original community project.', topic: 'community', language: 'en', confidence: 0.85, reward_sats: 21 }));
}
export const catalog = { models: [{ slug: 'native-default', context_window: 200000, priority: 0, apply_patch_tool_type: 'freeform', shell_type: 'unified_exec', experimental_supported_tools: ['clock', 'send_user_message_async'], tool_mode: 'code_mode_only', multi_agent_version: 'v2', web_search_tool_type: 'text' }] };
export class FakeProcess extends EventEmitter implements ProcessTransport {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  messages: RpcMessage[] = []; killed = false; #buffer = '';
  constructor(handler: (m: RpcMessage, p: FakeProcess) => void) {
    super();
    this.stdin.on('data', (data: Buffer) => {
      this.#buffer += data.toString(); let i: number;
      while ((i = this.#buffer.indexOf('\n')) >= 0) {
        const m = JSON.parse(this.#buffer.slice(0, i)) as RpcMessage;
        this.#buffer = this.#buffer.slice(i + 1); this.messages.push(m);
        queueMicrotask(() => handler(m, this));
      }
    });
  }
  send(m: RpcMessage): void { this.stdout.write(JSON.stringify(m) + '\n'); }
  kill(): boolean { if (!this.killed) { this.killed = true; this.emit('exit', 0); this.emit('close', 0); } return true; }
}
export interface FakeOptions {
  account?: unknown; quota?: unknown;
  onTurn?: (m: RpcMessage, p: FakeProcess) => void;
  inspect?: (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => void;
}
export function fakeFactory(b = batch(), options: FakeOptions = {}): { factory: ProcessFactory; calls: RpcMessage[]; children: FakeProcess[] } {
  const calls: RpcMessage[] = []; const children: FakeProcess[] = [];
  const factory: ProcessFactory = (_executable, args, opts) => {
    options.inspect?.(args, opts);
    const process = new FakeProcess((m, p) => {
      calls.push(m);
      if (!m.method) return;
      const respond = (result: unknown): void => p.send({ id: m.id!, result });
      switch (m.method) {
        case 'initialize': respond({ userAgent: 'fake' }); break;
        case 'initialized': break;
        case 'account/read': respond(options.account ?? { account: { type: 'chatgpt', email: 'private@example.invalid', planType: 'plus' }, requiresOpenaiAuth: true }); break;
        case 'account/rateLimits/read': respond(options.quota ?? { ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 20 }, secondary: { usedPercent: 40 }, credits: { hasCredits: false, unlimited: false, balance: '0' } } }); break;
        case 'config/read': respond({ config: { model_catalog_json: join(opts.env.HOME!, 'catalog.json'), model_provider: 'openai', approval_policy: 'never', sandbox_mode: 'read-only', web_search: 'disabled', features: { ...Object.fromEntries(DISABLED_FEATURES.map(k => [k, false])), skip_host_skill_discovery: true }, agents: { enabled: false }, cloud: { skills: { enabled: false } }, orchestrator: { mcp: { enabled: false } } } }); break;
        case 'configRequirements/read': respond({ requirements: null }); break;
        case 'thread/start': respond({ thread: { id: 'thread' }, model: 'native-default', modelProvider: 'openai', instructionSources: [], approvalPolicy: 'never', sandbox: { type: 'readOnly', networkAccess: false } }); break;
        case 'turn/start':
          if (options.onTurn) { options.onTurn(m, p); break; }
          respond({ turn: { id: 'turn', status: 'inProgress', items: [] } });
          p.send({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 21 } } } });
          p.send({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { type: 'agentMessage', id: 'final', phase: 'final_answer', text: JSON.stringify({ decisions: decisions(b) }) } } });
          p.send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [] } } });
          break;
        default: respond({});
      }
    });
    children.push(process);
    if (args[0] === '--version') setImmediate(() => { process.stdout.write('codex-cli 0.163.0\n'); process.emit('exit', 0); process.emit('close', 0); });
    if (args[0] === 'debug') setImmediate(() => { process.stdout.write(JSON.stringify(catalog)); process.emit('exit', 0); process.emit('close', 0); });
    return process;
  };
  return { factory, calls, children };
}
