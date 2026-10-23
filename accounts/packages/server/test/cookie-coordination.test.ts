import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAccountClient, createAccountAuthScope } from '../../client/src/index.ts';
import type { AccountTransport } from '../../client/src/index.ts';
import { TestCookieJar } from './https-fixture.ts';
import { fixture, baseURL, origin, password } from './fixtures.ts';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function setup(timeoutMs = 2000) {
  const f = await fixture(); await f.register(); await f.verify();
  const jar = new TestCookieJar(), waiting = deferred(), release = deferred(), completed = deferred(); let held = false;
  const calls: string[] = [];
  const transport: AccountTransport = async operation => {
    const url = new URL(operation.url); calls.push(url.pathname);
    const response = await f.app.handler(new Request(url, { method: operation.method, headers: { origin, cookie: jar.header(url), ...(operation.body ? { 'content-type': 'application/json' } : {}) }, ...(operation.body ? { body: operation.body } : {}) }));
    if (url.pathname.endsWith('/sign-in/email') && !held) { held = true; waiting.resolve(); await release.promise; }
    jar.accept(url, response.headers.getSetCookie());
    const body = await response.text(); if (held) completed.resolve();
    return { status: response.status, body };
  };
  return { f, jar, waiting, release, completed, calls, transport, client: createAccountClient({ baseURL, transport, timeoutMs }), async close() { release.resolve(); await f.app.whenIdle(); await f.close(); } };
}

test('successful logout waits for delayed real login cookies and a new SDK cannot restore that session', async () => {
  const f = await setup(); try {
    const login = f.client.login('reader@example.test', password).then(() => 'success', error => error.code);
    await f.waiting.promise;
    let loggedOut = false; const logout = f.client.logout().then(() => { loggedOut = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(loggedOut, false, 'logout cannot complete before the earlier cookie write');
    f.release.resolve(); await logout; assert.equal(await login, 'STALE_AUTH_STATE');
    assert.equal(await f.client.getSession(), null);
    assert.equal(await createAccountClient({ baseURL, transport: f.transport }).getSession(), null);
    assert.equal(f.jar.header(new URL(baseURL)), '');
  } finally { await f.close(); }
});

test('a transport ignoring deadlines keeps a shared fence until explicit successful logout', async () => {
  const f = await setup(30); try {
    const login = f.client.login('reader@example.test', password).then(() => 'success', error => error.code);
    await f.waiting.promise; assert.equal(await login, 'REQUEST_TIMEOUT');
    await assert.rejects(f.client.logout(), { code: 'REQUEST_TIMEOUT' });
    assert.equal(f.calls.filter(path => path.endsWith('/sign-out')).length, 0);
    const later = createAccountClient({ baseURL, transport: f.transport, timeoutMs: 30 });
    await assert.rejects(later.getSession(), error => ['REQUEST_TIMEOUT', 'TEMPORARILY_UNAVAILABLE'].includes((error as { code: string }).code));
    f.release.resolve(); await f.completed.promise; await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(later.getSession(), { code: 'TEMPORARILY_UNAVAILABLE' });
    await later.logout(); assert.equal(await createAccountClient({ baseURL, transport: f.transport }).getSession(), null);
    assert.equal(f.calls.filter(path => path.endsWith('/sign-out')).length, 1, 'timed-out queued logout never runs later');
  } finally { await f.close(); }
});

test('a reset waits for delayed login cookies and preserves all-session revocation for a later SDK', async () => {
  const f = await setup(); try {
    await f.client.requestRecovery('reader@example.test'); const token = f.f.mail.findLast(message => message.kind === 'password-reset')!.token;
    const login = f.client.login('reader@example.test', password).then(() => 'success', error => error.code); await f.waiting.promise;
    const reset = f.client.resetPassword(token, 'replacement fixture password'); f.release.resolve(); await reset; assert.equal(await login, 'STALE_AUTH_STATE');
    assert.equal(await createAccountClient({ baseURL, transport: f.transport }).getSession(), null);
    await f.client.login('reader@example.test', 'replacement fixture password'); assert.ok(f.client.currentSession);
  } finally { await f.close(); }
});


test('a later explicit login wins across SDK instances sharing one real cookie jar', async () => {
  const f = await setup(); try {
    const original = f.client.login('reader@example.test', password).then(() => 'success', error => error.code); await f.waiting.promise;
    const next = createAccountClient({ baseURL, transport: f.transport }); const newest = next.login('reader@example.test', password);
    f.release.resolve(); const accepted = await newest; assert.equal(await original, 'STALE_AUTH_STATE'); assert.equal(f.client.currentSession, null);
    assert.equal((await createAccountClient({ baseURL, transport: f.transport }).getSession())?.session.id, accepted.session.id);
  } finally { await f.close(); }
});

test('explicit shared scope coordinates different adapters using the same real cookie jar', async () => {
  const f = await setup(); try {
    const authScope = createAccountAuthScope();
    const first = createAccountClient({ baseURL, transport: operation => f.transport(operation), authScope });
    const second = createAccountClient({ baseURL, transport: operation => f.transport(operation), authScope });
    const login = first.login('reader@example.test', password).then(() => 'success', error => error.code); await f.waiting.promise;
    let finished = false; const logout = second.logout().then(() => { finished = true; }); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(finished, false);
    f.release.resolve(); await logout; assert.equal(await login, 'STALE_AUTH_STATE');
    assert.equal(await createAccountClient({ baseURL, transport: operation => f.transport(operation), authScope }).getSession(), null);
  } finally { await f.close(); }
});

test('unsettled transport keeps a bounded queue and expired queued mutations never dispatch', async () => {
  const f = await setup(30); try {
    const login = f.client.login('reader@example.test', password).catch(error => error.code); await f.waiting.promise; assert.equal(await login, 'REQUEST_TIMEOUT');
    const results = await Promise.all(Array.from({ length: 10 }, () => f.client.logout().then(() => 'success', error => error.code)));
    assert.equal(results.filter(code => code === 'REQUEST_TIMEOUT').length, 7);
    assert.equal(results.filter(code => code === 'TEMPORARILY_UNAVAILABLE').length, 3);
    assert.equal(f.calls.filter(path => path.endsWith('/sign-out')).length, 0);
    f.release.resolve(); await f.completed.promise; await new Promise(resolve => setImmediate(resolve));
    await f.client.logout(); assert.equal(await createAccountClient({ baseURL, transport: f.transport }).getSession(), null);
    assert.equal(f.calls.filter(path => path.endsWith('/sign-out')).length, 1);
  } finally { await f.close(); }
});

for (const route of ['get-session', 'send-verification-email'] as const) test(`native ${route} deletion cookies finish before a later login`, async () => {
  const f = await fixture(); const release = deferred(), waiting = deferred(); let held = false, hold = false, loginDispatches = 0; let pendingLogin: Promise<unknown> | undefined;
  try {
    await f.register(); await f.verify();
    const jar = new TestCookieJar(); let deletionCookies = 0;
    const transport: AccountTransport = async operation => {
      const url = new URL(operation.url);
      if (url.pathname.endsWith('/sign-in/email')) loginDispatches++;
      const response = await f.app.handler(new Request(url, { method: operation.method, headers: { origin, cookie: jar.header(url), ...(operation.body ? { 'content-type': 'application/json' } : {}) }, ...(operation.body ? { body: operation.body } : {}) }));
      if (hold && !held && url.pathname.endsWith('/' + route)) {
        held = true; deletionCookies = response.headers.getSetCookie().filter(value => /Max-Age=0/i.test(value)).length;
        waiting.resolve(); await release.promise;
      }
      jar.accept(url, response.headers.getSetCookie()); return { status: response.status, body: await response.text() };
    };
    const first = createAccountClient({ baseURL, transport }), second = createAccountClient({ baseURL, transport });
    await first.login('reader@example.test', password);
    const { default: Database } = await import('better-sqlite3'); const db = new Database(f.databasePath); db.exec('DELETE FROM session'); db.close();
    hold = true;
    const old = (route === 'get-session' ? first.getSession() : first.requestVerification('reader@example.test')).then(() => 'success', error => error.code);
    await waiting.promise; assert.ok(deletionCookies > 0, 'the actual native response must contain session deletion cookies');
    const newer = second.login('reader@example.test', password).then(value => ({ value }), error => ({ error: error.code })); pendingLogin = newer;
    assert.equal(loginDispatches, 1, 'new login must not dispatch before the earlier cookie deletion');
    release.resolve(); const accepted = await newer; assert.ok('value' in accepted);
    assert.equal(await old, route === 'get-session' ? 'STALE_AUTH_STATE' : 'success');
    assert.equal((await second.getSession())?.session.id, accepted.value.session.id);
    assert.equal((await createAccountClient({ baseURL, transport }).getSession())?.session.id, accepted.value.session.id);
  } finally { release.resolve(); await pendingLogin; await f.app.whenIdle(); await f.close(); }
});
