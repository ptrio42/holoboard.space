import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createReviewServer, startReview } from '../src/review.ts';
import { parseReviewSnapshot, ReviewBackend } from '../src/review-backend.ts';
import type { ReviewAction, ReviewSnapshot } from '../src/review-backend.ts';
import { SafeError } from '../src/contract.ts';

function snapshot(): ReviewSnapshot {
  return { mode: 'dry_run', review_required: true, spending_allowed: false, daily_reward_sats: 1000,
    daily_discoveries: 3, pending_count: 1, offset: 0, items: [{
      note_id: 'a'.repeat(64), review_id: 'b'.repeat(64), event: { id: 'a'.repeat(64), pubkey: 'c'.repeat(64), content: 'Original multilingual post. 日本語 Polski. <script>alert("untrusted")</script>' },
      reason: 'An original and useful project.', topic: 'projects', language: 'en', reward_sats: 100,
      created_at: '2026-10-18T10:00:00Z', expires_at: '2026-10-25T10:00:00Z', dry_run: true, published: false,
    }] };
}

async function fixture(t: { after(fn: () => unknown): void }, fail = false) {
  const data = snapshot(), actions: ReviewAction[] = [];
  const server = createReviewServer({ port: 0, client: {
    async snapshot() { return data; },
    async act(action) { actions.push(action); if (fail) throw new SafeError('backend_http_409'); return { dry_run: true }; },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const response = await fetch(origin), html = await response.text();
  const csrf = html.match(/name="csrf" value="([a-f0-9]{64})"/)?.[1]; assert.ok(csrf);
  const submit = (values: Record<string, string>, headers: Record<string, string> = {}) => fetch(origin + '/actions', {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ csrf, ...values }),
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded', ...headers },
  });
  return { origin, html, response, csrf, actions, data, submit };
}

test('review displays complete escaped posts, proposed rewards, and no credentials', async t => {
  const f = await fixture(t);
  assert.ok(f.html.includes('100 sats'));
  assert.ok(f.html.includes('日本語 Polski.'));
  assert.ok(f.html.includes('&lt;script&gt;'));
  assert.equal(f.html.includes('<script>'), false);
  assert.match(f.response.headers.get('content-security-policy')!, /form-action 'self'/);
  assert.match(f.response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal(f.response.headers.get('referrer-policy'), 'same-origin');
  for (const path of ['/style.css', '/assets/pixel.woff2', '/assets/mark.svg']) assert.equal((await fetch(f.origin + path)).status, 200);
  assert.equal((await fetch(f.origin + '/operator.json')).status, 404);
});

test('review forwards only the explicit note, proposal binding and reward; refresh never repeats POST', async t => {
  const f = await fixture(t), item = f.data.items[0]!;
  const response = await f.submit({ action: 'approve', note_id: item.note_id, review_id: item.review_id, reward_sats: '100' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/?result=preview_approved');
  assert.deepEqual(f.actions, [{ action: 'approve', note_id: item.note_id, review_id: item.review_id, reward_sats: 100 }]);
  assert.equal((await fetch(f.origin + response.headers.get('location'))).status, 200);
  assert.equal(f.actions.length, 1);
});

test('review rejects cross-origin, stale CSRF, malformed IDs and invalid reward without a backend write', async t => {
  const f = await fixture(t), item = f.data.items[0]!;
  const valid = { action: 'approve', note_id: item.note_id, review_id: item.review_id, reward_sats: '100' };
  assert.equal((await f.submit(valid, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await f.submit(valid, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.submit({ ...valid, csrf: 'invalid' })).status, 403);
  assert.equal((await f.submit({ ...valid, note_id: 'invalid' })).status, 400);
  assert.equal((await f.submit({ ...valid, reward_sats: '1000' })).status, 400);
  // Native fetch derives Host from the URL. Exercise the actual wire header.
  const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(f.origin, { headers: { host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(badHostStatus, 403);
  assert.equal(f.actions.length, 0);
});

test('turning review off requires explicit confirmation; turning it on is immediate', async t => {
  const f = await fixture(t);
  assert.equal((await f.submit({ action: 'set_review', review_required: 'false' })).status, 400);
  assert.equal(f.actions.length, 0);
  assert.equal((await f.submit({ action: 'set_review', review_required: 'false', confirm_auto: 'yes' })).status, 303);
  assert.equal((await f.submit({ action: 'set_review', review_required: 'true' })).status, 303);
  assert.deepEqual(f.actions, [{ action: 'set_review', review_required: false }, { action: 'set_review', review_required: true }]);
});

test('a stale approval reports conflict without falsely claiming a payment or exposing backend errors', async t => {
  const f = await fixture(t, true), item = f.data.items[0]!;
  const response = await f.submit({ action: 'approve', note_id: item.note_id, review_id: item.review_id, reward_sats: '100' });
  assert.equal(response.status, 409);
  assert.ok((await response.text()).includes('Refresh the queue'));
});

test('review client keeps its bearer server-side and refuses redirects', async t => {
  let authorizations: string[] = [];
  const server = createServer((req, res) => {
    authorizations.push(req.headers.authorization ?? '');
    if (req.url?.includes('offset=21')) { res.writeHead(302, { Location: 'https://attacker.example' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(snapshot()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new ReviewBackend(`http://127.0.0.1:${address.port}`, 'private-review-bearer');
  assert.equal((await client.snapshot()).pending_count, 1);
  assert.deepEqual(authorizations, ['Bearer private-review-bearer']);
  await assert.rejects(client.snapshot(21), /backend_request_failed/);
});

test('review validates configuration and the snapshot contract before starting or rendering', async () => {
  await assert.rejects(startReview({}), /explicit_review_token_and_backend_required/);
  await assert.rejects(startReview({ CURATOR_BACKEND_URL: 'http://127.0.0.1:1', CURATOR_REVIEW_TOKEN: 'r'.repeat(32), CURATOR_TOKEN: 'r'.repeat(32) }), /separate_review_token_required/);
  await assert.rejects(startReview({ CURATOR_BACKEND_URL: 'http://127.0.0.1:1', CURATOR_REVIEW_TOKEN: 'r'.repeat(32), CURATOR_REVIEW_PORT: '0' }), /invalid_review_port/);
  for (const mutate of [
    (s: ReviewSnapshot) => { s.items[0]!.note_id = 'javascript:alert(1)'; },
    (s: ReviewSnapshot) => { s.items[0]!.reward_sats = 1000; },
    (s: ReviewSnapshot) => { s.pending_count = -1; },
  ]) { const data = snapshot(); mutate(data); assert.throws(() => parseReviewSnapshot(data), /invalid_review_snapshot/); }
});
