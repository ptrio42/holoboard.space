import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as sdk from '../src/index.ts';
const user = { id: 'one', email: 'reader@example.test', emailVerified: true, name: 'Reader' };
const session = { user, session: { id: 's', expiresAt: new Date(Date.now() + 60000).toISOString() } };
test('client maps ordinary operations to the actual native wire and normalizes session state', async () => {
  assert.equal(typeof sdk.createAccountClient, 'function');
  const calls: any[] = [];
  const client = sdk.createAccountClient({ baseURL: 'https://accounts.test', transport: async (request: any) => {
      calls.push(request);
      return { status: request.url.includes('verify-email') ? 302 : 200, body: JSON.stringify(request.url.includes('get-session') ? session : request.url.includes('sign-in') ? { user } : { accepted: true }) };
    } });
  await client.register({ email: user.email, password: 'test password', name: user.name });
  await client.verifyEmail('token', 'https://web.test/complete');
  await client.requestVerification(user.email);
  await client.login(user.email, 'test password');
  assert.equal((await client.getSession())?.user.id, user.id);
  await client.requestRecovery(user.email);
  await client.resetPassword('token', 'new password');
  await client.logout();
  assert.deepEqual(calls.map(x => new URL(x.url).pathname), ['/v1/auth/sign-up/email', '/v1/auth/verify-email', '/v1/auth/send-verification-email', '/v1/auth/sign-in/email', '/v1/auth/get-session', '/v1/auth/get-session', '/v1/auth/request-password-reset', '/v1/auth/reset-password', '/v1/auth/sign-out']);
  assert.ok(calls.every(x => x.maxResponseBytes === 131072));
});
test('late session reads cannot restore state after logout and errors expose only stable codes', async () => {
  assert.equal(typeof sdk.createAccountClient, 'function');
  let complete!: (x: any) => void;
  const client = sdk.createAccountClient({ baseURL: 'https://accounts.test', transport: async (r: any) => r.url.includes('get-session') ? new Promise(resolve => {
      complete = resolve;
    }) : { status: 200, body: '{}' } });
  const pending = client.getSession();
  await client.logout();
  complete({ status: 200, body: JSON.stringify(session) });
  await assert.rejects(pending, { code: 'STALE_AUTH_STATE' });
  assert.equal(client.currentSession, null);
  const broken = sdk.createAccountClient({ baseURL: 'https://accounts.test', transport: async () => {
      throw new Error('private password token');
    } });
  await assert.rejects(broken.login('a@example.test', 'secret'), (e: any) => e.code === 'NETWORK_ERROR' && !String(e).includes('private'));
});
test('request bytes are bounded and no request or export is retried', async () => {
  assert.equal(typeof sdk.createAccountClient, 'function');
  let calls = 0;
  const client = sdk.createAccountClient({ baseURL: 'https://accounts.test', transport: async () => {
      calls++;
      return { status: 503, body: '{"error":{"code":"TEMPORARILY_UNAVAILABLE","message":"private"}}' };
    } });
  await assert.rejects(client.register({ email: 'r@example.test', password: '😀'.repeat(20000), name: 'R' }), { code: 'REQUEST_TOO_LARGE' });
  assert.equal(calls, 0);
  await assert.rejects(client.request('/v1/identity/export', { password: 'password' }), { code: 'TEMPORARILY_UNAVAILABLE', status: 503, retryable: true });
  assert.equal(calls, 1);
});
test('web transport uses credentials and actual streamed response bytes with a deadline', async () => {
  const requests: any[] = [];
  const fetcher = async (_url: string, init: any) => {
    requests.push(init);
    let sent = false;
    return { status: 200, headers: { get: () => null }, body: { getReader: () => ({ read: async () => sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array(131073) }), cancel: async () => {
          } }) } };
  };
  const transport = sdk.createWebTransport({ fetch: fetcher });
  await assert.rejects(transport({ url: 'https://accounts.test/v1/identity', method: 'GET', timeoutMs: 100, maxResponseBytes: 131072 }), { code: 'INVALID_RESPONSE' });
  assert.equal(requests[0].credentials, 'include');
  assert.equal(requests[0].redirect, 'manual');
  assert.equal(requests[0].cache, 'no-store');
  const hanging = sdk.createWebTransport({ fetch: async () => new Promise(() => {
    }) });
  await assert.rejects(hanging({ url: 'https://accounts.test', method: 'GET', timeoutMs: 10, maxResponseBytes: 131072 }), { code: 'REQUEST_TIMEOUT' });
});
test('a stale 401 does not clear a newer login, and newest login wins', async () => {
  let stale!: (r: any) => void;
  let sessions = 0;
  const client = sdk.createAccountClient({ baseURL: 'https://accounts.test', transport: async (r) => {
      if (r.url.includes('get-session')) {
        if (sessions++ === 0)
          return new Promise(resolve => {
            stale = resolve;
          });
        return { status: 200, body: JSON.stringify(session) };
      }
      return { status: 200, body: JSON.stringify({ user }) };
    } });
  const old = client.getSession();
  await client.login(user.email, 'password');
  stale({ status: 401, body: '{"error":{"code":"UNAUTHENTICATED"}}' });
  await assert.rejects(old);
  assert.equal(client.currentSession?.user.id, 'one');
});
test('a login waiting for session loading cannot return a newer same-account session', async () => {
  let release!: (r: any) => void;
  let sessions = 0;
  const client = sdk.createAccountClient({ baseURL: 'https://accounts.test', transport: async (r) => {
      if (r.url.includes('get-session')) {
        if (sessions++ === 0)
          return new Promise(resolve => {
            release = resolve;
          });
        return { status: 200, body: JSON.stringify(session) };
      }
      return { status: 200, body: JSON.stringify({ user }) };
    } });
  const first = client.login(user.email, 'password');
  while (!release)
    await new Promise(resolve => setImmediate(resolve));
  await client.login(user.email, 'password');
  release({ status: 200, body: JSON.stringify(session) });
  await assert.rejects(first, { code: 'STALE_AUTH_STATE' });
});
test('explicit key export rejects malformed or mismatched backup keys and never retries', async () => {
  const {generateSecretKey,getPublicKey}=await import('nostr-tools/pure');const {nsecEncode}=await import('nostr-tools/nip19');
  const secret=generateSecretKey(),publicKey=getPublicKey(secret);let exported='nsec1p',calls=0;
  const client=sdk.createAccountClient({baseURL:'https://accounts.test',transport:async r=>{
    if(r.url.includes('get-session'))return {status:200,body:JSON.stringify(session)};
    if(r.url.endsWith('/identity'))return {status:200,body:JSON.stringify({accountId:user.id,publicKey,capabilities:{allowedKinds:[1],exportEnabled:true}})};
    calls++;return {status:200,body:JSON.stringify({publicKey,nsec:exported})};
  }});
  await client.getSession();await assert.rejects(client.exportKey('password'),{code:'INVALID_RESPONSE'});assert.equal(calls,1);
  exported=nsecEncode(generateSecretKey());await assert.rejects(client.exportKey('password'),{code:'INVALID_RESPONSE'});assert.equal(calls,2);
  exported=nsecEncode(secret);assert.equal((await client.exportKey('password')).nsec,exported);assert.equal(calls,3);
});
test('retry hints follow HTTP status without trusting remote retryable fields', async () => {
  const unavailable=sdk.createAccountClient({baseURL:'https://accounts.test',transport:async()=>({status:503,body:'{"error":{"code":"IDENTITY_UNAVAILABLE","retryable":false}}'})});
  await assert.rejects(unavailable.request('/v1/identity'),{code:'IDENTITY_UNAVAILABLE',retryable:true,status:503});
});
test('authentication prefix cannot inject a query or fragment into native route URLs', () => {
  for(const authBasePath of ['/auth?','/auth#','//auth','/auth/'])assert.throws(()=>sdk.createAccountClient({baseURL:'https://accounts.test',authBasePath,transport:async()=>({status:200,body:'null'})}),{code:'INVALID_INPUT'});
});
