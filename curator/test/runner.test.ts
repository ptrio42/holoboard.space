import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { Backend, backendOrigin } from '../src/backend.ts';
import { StateStore, SLOT_MS } from '../src/state.ts';
import { runOnce, watch } from '../src/runner.ts';
import { SafeError, parseDecisions } from '../src/contract.ts';
import type { Decision, Payload } from '../src/contract.ts';
import { batch, decisions } from './helpers.ts';

const origin = 'http://127.0.0.1:3334';
const now = Date.UTC(2026, 9, 18, 1);
async function stateTest(fn: (store: StateStore, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'curator-state-test-'));
  try { await fn(new StateStore(join(dir, 'state.json'), origin), dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
function fixture() {
  let modelCalls = 0; const submitted: Payload[] = [];
  const backend = { candidates: async () => batch(), submit: async (p: Payload) => { submitted.push(structuredClone(p)); } };
  const editor = { check: async () => {}, evaluate: async () => { modelCalls++; return decisions(); } };
  return { backend, editor, submitted, calls: () => modelCalls };
}

test('at most one evaluation per UTC 12-hour slot and two per day, including restarts', async () => {
  await stateTest(async (store, dir) => {
    const f = fixture();
    assert.equal(await runOnce(store, f.backend, f.editor, () => now), 'submitted');
    assert.equal(await runOnce(new StateStore(store.path, origin), f.backend, f.editor, () => now + 60_000), 'already_attempted');
    assert.equal(await runOnce(store, f.backend, f.editor, () => now + SLOT_MS), 'submitted');
    assert.equal(await runOnce(store, f.backend, f.editor, () => now + 2 * 60_000), 'already_attempted');
    assert.equal(f.calls(), 2);
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
    assert.equal((await readFile(store.path, 'utf8')).includes('Bearer'), false);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  });
});

test('failure and a crash after the durable pre-inference write consume the slot', async () => {
  await stateTest(async store => {
    const f = fixture();
    f.editor.evaluate = async () => { throw new Error('sensitive upstream failure'); };
    await assert.rejects(runOnce(store, f.backend, f.editor, () => now), /editor_failed/);
    assert.equal(await runOnce(store, f.backend, f.editor, () => now), 'already_attempted');
    await store.lock(async () => {
      const s = await store.load(); store.start(s, now + SLOT_MS); await store.save(s);
    });
    assert.equal(await runOnce(new StateStore(store.path, origin), f.backend, fixture().editor, () => now + SLOT_MS), 'already_attempted');
  });
});

test('sleep skips all missed slots; clock rollback never replays a pruned attempt', async () => {
  await stateTest(async store => {
    const f = fixture();
    await runOnce(store, f.backend, f.editor, () => now);
    assert.equal(await runOnce(store, f.backend, f.editor, () => now + 60 * SLOT_MS), 'submitted');
    assert.equal(f.calls(), 2);
    assert.equal(await runOnce(store, f.backend, f.editor, () => now), 'already_attempted');
    assert.equal((await store.load()).attempts.length, 1);
  });
});

test('state remains bounded after many days without catch-up', async () => {
  await stateTest(async store => {
    const f = fixture();
    for (let i = 0; i < 40; i++) await runOnce(store, f.backend, f.editor, () => now + i * SLOT_MS);
    assert.equal((await store.load()).attempts.length, 28);
    assert.ok((await stat(store.path)).size < 20_000);
    assert.equal(f.calls(), 40);
  });
});

test('simultaneous processes cannot share the inference lock', async () => {
  await stateTest(async store => {
    await store.lock(async () => {
      await assert.rejects(store.lock(async () => {}), /runner_locked/);
      const child = spawn(process.execPath, ['--experimental-strip-types', new URL('./lock-worker.ts', import.meta.url).pathname, store.path], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', d => { output += String(d); });
      const [code] = await once(child, 'exit');
      assert.equal(code, 2); assert.equal(output, 'runner_locked');
    });
    await store.lock(async () => {});
  });
});

test('pending submission is durable before HTTP call; retries preserve identical UUID and payload', async () => {
  await stateTest(async store => {
    const f = fixture(); let first: Payload | undefined;
    f.backend.submit = async p => {
      assert.deepEqual((await store.load()).pending, p);
      if (!first) { first = structuredClone(p); throw new SafeError('backend_request_failed'); }
      assert.deepEqual(p, first); f.submitted.push(structuredClone(p));
    };
    await assert.rejects(runOnce(store, f.backend, f.editor, () => now), /backend_request_failed/);
    assert.equal(await runOnce(new StateStore(store.path, origin), f.backend, f.editor, () => now + SLOT_MS), 'retried_submission');
    assert.equal(f.calls(), 1); assert.equal(f.submitted.length, 1); assert.equal((await store.load()).pending, undefined);
  });
});

test('failed retries block all further inference, even after the next slot', async () => {
  await stateTest(async store => {
    const f = fixture(); f.backend.submit = async () => { throw new SafeError('backend_http_409'); };
    await assert.rejects(runOnce(store, f.backend, f.editor, () => now), /409/);
    await assert.rejects(runOnce(store, f.backend, f.editor, () => now + SLOT_MS), /409/);
    assert.equal(f.calls(), 1);
  });
});

test('empty, completed, disabled and oversized batches do not use the model', async () => {
  await stateTest(async store => {
    const f = fixture();
    for (const b of [{ ...batch(), completed: true }, { ...batch(), mode: 'disabled' as const }, { ...batch(), candidates: [] }]) {
      f.backend.candidates = async () => b;
      await runOnce(store, f.backend, f.editor, () => now);
    }
    const b = batch(); b.candidates[0]!.event.content = 'x'.repeat(200_000);
    f.backend.candidates = async () => b;
    await assert.rejects(runOnce(store, f.backend, f.editor, () => now), /batch_prompt_too_large/);
    assert.equal(f.calls(), 0);
  });
});

test('corrupt or backend-mismatched state fails closed', async () => {
  await stateTest(async store => {
    await writeFile(store.path, '{}', { mode: 0o600 });
    await assert.rejects(store.load(), /state_invalid/);
    const other = new StateStore(store.path, 'https://other.example');
    await store.lock(async () => { await store.save({ version: 1, backend: origin, high_water_slot: -1, attempts: [] }); });
    await assert.rejects(other.load(), /state_invalid/);
  });
});

test('watch uses one check at a time and rejects busy-loop intervals', async () => {
  const signal = new AbortController(); let runs = 0;
  await watch(async () => { runs++; signal.abort(); return 'already_attempted'; }, () => {}, signal.signal, 60_000);
  assert.equal(runs, 1);
  await assert.rejects(watch(async () => 'empty', () => {}, new AbortController().signal, 10), /watch_interval_too_short/);
});

async function startServer(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const a = server.address(); if (!a || typeof a === 'string') throw new Error('no port');
  return 'http://127.0.0.1:' + a.port;
}
async function stopServer(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }

test('local fake backend lost-response retry receives byte-identical JSON without another model call', async () => {
  await stateTest(async store => {
    const posts: string[] = []; let modelCalls = 0;
    const server = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, 'Bearer local-only-test-token');
      if (req.url === '/api/curator/candidates') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(batch())); return; }
      const buffers: Buffer[] = []; for await (const chunk of req) buffers.push(chunk as Buffer);
      const raw = Buffer.concat(buffers).toString(); posts.push(raw);
      if (posts.length === 1) { req.socket.destroy(); return; }
      const p = JSON.parse(raw) as Payload;
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ run_id: p.run_id, mode: 'dry_run', published: [], proposed: [p.decisions[0]!.note_id], rejected: [] }));
    });
    const local = await startServer(server);
    try {
      const backend = new Backend(local, 'local-only-test-token', 1000);
      const localStore = new StateStore(store.path, local);
      const editor = { check: async () => {}, evaluate: async () => { modelCalls++; return decisions(); } };
      await assert.rejects(runOnce(localStore, backend, editor, () => now), /backend_request_failed/);
      assert.equal(await runOnce(localStore, backend, editor, () => now + SLOT_MS), 'retried_submission');
      assert.equal(modelCalls, 1); assert.equal(posts.length, 2); assert.equal(posts[0], posts[1]);
    } finally { await stopServer(server); }
  });
});

test('backend disallows userinfo and non-local plaintext URLs; redirects do not forward bearer', async () => {
  for (const raw of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com/?token=x']) assert.throws(() => backendOrigin(raw));
  assert.equal(backendOrigin('https://backend.example'), 'https://backend.example');
  let destinationCalls = 0;
  const destination = createServer((_req, res) => { destinationCalls++; res.end('{}'); });
  const target = await startServer(destination);
  const source = createServer((_req, res) => { res.writeHead(302, { location: target }); res.end(); });
  const base = await startServer(source);
  try { await assert.rejects(new Backend(base, 'local-test-token').candidates(), /backend_request_failed/); assert.equal(destinationCalls, 0); }
  finally { await stopServer(source); await stopServer(destination); }
});

test('definitive 410 clears only a never-admitted pending submission and allows a later current-slot run', async () => {
  await stateTest(async store => {
    const f = fixture(); let posts = 0;
    f.backend.submit = async () => { posts++; throw new SafeError(posts === 1 ? 'backend_request_failed' : 'backend_http_410'); };
    await assert.rejects(runOnce(store, f.backend, f.editor, () => now), /backend_request_failed/);
    assert.equal(await runOnce(store, f.backend, f.editor, () => now + 10 * SLOT_MS), 'expired_submission');
    assert.equal(f.calls(), 1); assert.equal((await store.load()).pending, undefined);
    f.backend.submit = async p => { f.submitted.push(p); };
    assert.equal(await runOnce(store, f.backend, f.editor, () => now + 10 * SLOT_MS), 'submitted');
    assert.equal(f.calls(), 2);
  });
});

test('a durable accepted run replays after long sleep without fetching a disabled or expired batch', async () => {
  await stateTest(async store => {
    const f = fixture(); let saved: string | undefined;
    f.backend.submit = async p => {
      const raw = JSON.stringify(p);
      if (saved) { assert.equal(raw, saved); return; }
      saved = raw; throw new SafeError('backend_request_failed');
    };
    await assert.rejects(runOnce(store, f.backend, f.editor, () => now), /backend_request_failed/);
    f.backend.candidates = async () => { throw new Error('Must not fetch a new batch before receipt recovery'); };
    assert.equal(await runOnce(store, f.backend, f.editor, () => now + 100 * SLOT_MS), 'retried_submission');
    assert.equal(f.calls(), 1);
  });
});

test('HTTP transport accepts a valid signed-event batch exceeding two megabytes before fitting whole notes', async () => {
  const b = batch(50);
  for (const candidate of b.candidates) candidate.event.content = 'x'.repeat(60_000);
  assert.ok(Buffer.byteLength(JSON.stringify(b)) > 2_000_000);
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); });
  const base = await startServer(server);
  try { assert.equal((await new Backend(base, 'local-test-token').candidates()).candidates.length, 50); }
  finally { await stopServer(server); }
});

test('oversized runtime-valid Unicode output fails its slot before persisting or submitting a pending payload', async () => {
  await stateTest(async store => {
    const reviewed = batch(50);
    let output: Decision[] = reviewed.candidates.map(c => ({
      note_id: c.event.id, selected: false, reason: '\u0001'.repeat(280),
      topic: 'community', language: 'en', confidence: 0, reward_sats: 21,
    }));
    assert.equal(parseDecisions({ decisions: output }, reviewed.candidates.map(c => c.event.id), reviewed).length, 50);
    assert.ok(Buffer.byteLength(JSON.stringify({ decisions: output })) < 100_000);
    assert.ok(Buffer.byteLength(JSON.stringify({ run_id: '00000000-0000-4000-8000-000000000000', batch_id: reviewed.batch_id, decisions: output })) > 65_536);
    let evaluations = 0; let submissions = 0;
    const backend = { candidates: async () => reviewed, submit: async () => { submissions++; } };
    const editor = { check: async () => {}, evaluate: async () => { evaluations++; return output; } };
    await assert.rejects(runOnce(store, backend, editor, () => now), /decisions_payload_too_large/);
    const failed = await store.load();
    assert.equal(failed.pending, undefined);
    assert.equal(failed.attempts.length, 1);
    assert.equal(failed.attempts[0]!.status, 'failed');
    assert.equal(submissions, 0);
    assert.equal(await runOnce(new StateStore(store.path, origin), backend, editor, () => now), 'already_attempted');
    assert.equal(evaluations, 1);
    output = output.map(d => ({ ...d, reason: 'Skipped after reviewing the supplied material.' }));
    assert.equal(await runOnce(new StateStore(store.path, origin), backend, editor, () => now + SLOT_MS), 'submitted');
    assert.equal(evaluations, 2);
    assert.equal(submissions, 1);
    const recovered = await store.load();
    assert.equal(recovered.pending, undefined);
    assert.deepEqual(recovered.attempts.map(a => a.status), ['failed', 'submitted']);
  });
});
