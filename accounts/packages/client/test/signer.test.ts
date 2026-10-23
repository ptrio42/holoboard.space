import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalizeEvent, generateSecretKey, getPublicKey, verifiedSymbol } from 'nostr-tools/pure';
import * as sdk from '../src/index.ts';
const secret = generateSecretKey(), pubkey = getPublicKey(secret);
const template = { kind: 1, created_at: 1700000000, content: 'Exact 😀 text', tags: [['t', 'one'], ['t', 'one']] };
const session = { user: { id: 'one', email: 'r@example.test', emailVerified: true, name: 'R' }, session: { id: 's', expiresAt: new Date(Date.now() + 60000).toISOString() } };
test('signer verifies exact event and ignores attacker-controlled cached verification symbols', () => {
  assert.equal(typeof sdk.validateSignedEvent, 'function');
  const event = finalizeEvent(structuredClone(template), secret);
  assert.equal(sdk.validateSignedEvent(event, template, pubkey).id, event.id);
  for (const field of ['content', 'kind', 'created_at', 'tags', 'pubkey', 'id', 'sig']) {
    const changed: any = { ...event, [field]: field === 'tags' ? [['t', 'two']] : field === 'kind' ? 2 : field === 'created_at' ? 1700000001 : field === 'content' ? 'tampered' : '0'.repeat(field === 'sig' ? 128 : 64), [verifiedSymbol]: true };
    assert.throws(() => sdk.validateSignedEvent(changed, template, pubkey), { code: 'INVALID_SIGNATURE' });
  }
});
test('signer snapshots template and rejects a signature completing after logout', async () => {
  assert.equal(typeof sdk.createAccountClient, 'function');
  let complete!: (x: any) => void;
  const client = sdk.createAccountClient({ baseURL: 'https://accounts.test', transport: async (r: any) => r.url.includes('get-session') ? { status: 200, body: JSON.stringify(session) } : r.url.endsWith('/identity') ? { status: 200, body: JSON.stringify({ accountId: 'one', publicKey: pubkey, capabilities: { allowedKinds: [1], exportEnabled: true } }) } : r.url.endsWith('/sign') ? new Promise(resolve => {
      complete = resolve;
    }) : { status: 200, body: '{}' } });
  await client.getSession();
  const requested = structuredClone(template);
  const pending = client.signer.signEvent(requested);
  while (!complete)
    await new Promise(resolve => setImmediate(resolve));
  requested.content = 'mutated';
  await client.logout();
  complete({ status: 200, body: JSON.stringify(finalizeEvent(structuredClone(template), secret)) });
  await assert.rejects(pending, { code: 'STALE_AUTH_STATE' });
});
test('identity binds the server session account even when a different client changed cookies', async () => {
  const client = sdk.createAccountClient({ baseURL: 'https://accounts.test', transport: async (r) => ({ status: 200, body: JSON.stringify(r.url.includes('get-session') ? session : { accountId: 'another-account', publicKey: pubkey, capabilities: { allowedKinds: [1], exportEnabled: true } }) }) });
  await client.getSession();
  await assert.rejects(client.signer.getPublicKey(), { code: 'STALE_AUTH_STATE' });
  assert.equal(client.currentSession, null);
});
test('an expired pending signature is rejected and near-limit response above 64 KiB is accepted exactly', async () => {
  let now = Date.now();
  let expire = false;
  const large = { ...template, content: 'a'.repeat(16000), tags: Array.from({ length: 24 }, () => ['t', 'a'.repeat(2048)]) };
  assert.ok(Buffer.byteLength(JSON.stringify(finalizeEvent(structuredClone(large), secret))) > 65536);
  const client = sdk.createAccountClient({ baseURL: 'https://accounts.test', now: () => now, transport: async (r) => {
      if (r.url.includes('get-session'))
        return { status: 200, body: JSON.stringify(session) };
      if (r.url.endsWith('/identity'))
        return { status: 200, body: JSON.stringify({ accountId: 'one', publicKey: pubkey, capabilities: { allowedKinds: [1], exportEnabled: true } }) };
      if (expire)
        now += 120000;
      return { status: 200, body: JSON.stringify(finalizeEvent(structuredClone(large), secret)) };
    } });
  await client.getSession();
  assert.equal((await client.signer.signEvent(large)).content, large.content);
  expire = true;
  await assert.rejects(client.signer.signEvent(large), { code: 'STALE_AUTH_STATE' });
});
test('caller event fields outside the exact template are rejected before transport', async () => {
  let calls = 0;
  const client = sdk.createAccountClient({ baseURL: 'https://accounts.test', transport: async () => {
      calls++;
      return { status: 200, body: JSON.stringify(session) };
    } });
  await client.getSession();
  for (const key of ['pubkey', 'id', 'sig', 'extra'])
    await assert.rejects(client.signer.signEvent({ ...template, [key]: 'unreviewed' }), { code: 'INVALID_INPUT' });
  assert.equal(calls, 1);
});
