import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as api from '../src/index.ts';
import { baseURL, origin, returnURL, password } from './fixtures.ts';
const oldSecret = 'old-auth-secret-fixture-at-least-32-characters';
const newSecret = 'new-auth-secret-fixture-at-least-32-characters';
const newerSecret = 'current-auth-secret-fixture-at-least-32-characters';
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'restore-test-'));
  const source = join(directory, 'source.sqlite'), backup = join(directory, 'backup.sqlite'), target = join(directory, 'target.sqlite');
  const custody: api.CustodyConfiguration = { installationId: 'restore-test', inventoryPath: join(directory, 'inventory'), encryption: { activeKid: 'old', keys: { old: new Uint8Array(32).fill(9) } } };
  api.initializeAccountDatabase(source); api.initializeIdentityInventory(custody.inventoryPath, custody.installationId); api.initializeAccountCustody(source, custody);
  const mail: api.AccountMail[] = [];
  const config = { databasePath: source, baseURL, secret: oldSecret, trustedOrigins: [origin], returnURLs: [returnURL], custody, signingPolicy: { allowedKinds: [1] }, explicitExportEnabled: true, sensitiveLimit: { maxRequests: 100, windowMs: 60000 }, mail: { send: async (message: api.AccountMail) => { mail.push(message); } } };
  const open = (databasePath = source, secret = oldSecret, customCustody = custody) => api.createAccountServer({ ...config, databasePath, secret, custody: customCustody });
  let app = open(), cookie = '';
  const request = async (path: string, body?: unknown) => {
    const response = await app.handler(new Request(baseURL + path, { method: body === undefined ? 'GET' : 'POST', headers: { origin, cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const value = response.headers.getSetCookie().find(value => value.startsWith('__Secure-better-auth.session_token=')); if (value) cookie = value.split(';')[0]!;
    return response;
  };
  const register = async (email = 'reader@example.test') => { assert.equal((await request('/v1/auth/sign-up/email', { email, password, name: 'Reader' })).status, 202); await app.mailOutbox!.drain(); };
  const verified = async () => { await register(); await app.handler(new Request(mail.at(-1)!.url)); assert.equal((await request('/v1/auth/sign-in/email', { email: 'reader@example.test', password })).status, 200); return await (await request('/v1/identity')).json() as { publicKey: string }; };
  return { directory, source, backup, target, custody, mail, open, request, register, verified, get app() { return app; }, replace(next: ReturnType<typeof open>) { app = next; }, async close() { try { app.close(); } catch {} await rm(directory, { recursive: true, force: true }); } };
}

test('public consistent backup refuses existing output and restore requires a fresh auth secret', async () => {
  assert.equal(typeof api.backupAccountDatabase, 'function');
  const f = await fixture(); try {
    await f.verified(); f.app.close();
    await api.backupAccountDatabase(f.source, f.backup);
    await assert.rejects(api.backupAccountDatabase(f.source, f.backup));
    for (const secret of [oldSecret, newerSecret]) await assert.rejects(api.restoreAccountDatabase({ backupPath: f.backup, targetPath: f.target, currentAuthSecret: newerSecret, newAuthSecret: secret, custody: f.custody }));
    const restored = await api.restoreAccountDatabase({ backupPath: f.backup, targetPath: f.target, currentAuthSecret: newerSecret, newAuthSecret: newSecret, custody: f.custody });
    assert.equal(restored.ready, true);
    await assert.rejects(api.restoreAccountDatabase({ backupPath: f.backup, targetPath: f.target, currentAuthSecret: newerSecret, newAuthSecret: newSecret, custody: f.custody }));
    assert.throws(() => f.open(f.target, oldSecret), /secret/i);
    assert.throws(() => f.open(f.target, newerSecret), /secret/i);
  } finally { await f.close(); }
});

test('restore revokes sessions, reset tokens, queued mail and obsolete passwords while preserving the signing identity', async () => {
  assert.equal(typeof api.restoreAccountDatabase, 'function');
  const f = await fixture(); try {
    const identity = await f.verified();
    await f.request('/v1/auth/request-password-reset', { email: 'reader@example.test' }); await f.app.mailOutbox!.drain(); const oldReset = f.mail.at(-1)!;
    await f.request('/v1/auth/request-password-reset', { email: 'reader@example.test' });
    f.app.close(); await api.backupAccountDatabase(f.source, f.backup);
    await api.restoreAccountDatabase({ backupPath: f.backup, targetPath: f.target, currentAuthSecret: oldSecret, newAuthSecret: newSecret, custody: f.custody });
    f.replace(f.open(f.target, newSecret)); await f.app.ready();
    assert.equal(f.app.mailOutbox!.status().queued, 0);
    assert.equal((await f.request('/v1/identity')).status, 401);
    assert.equal((await f.request('/v1/auth/reset-password', { token: oldReset.token, newPassword: password })).status, 400);
    assert.equal((await f.request('/v1/auth/sign-in/email', { email: 'reader@example.test', password })).status, 401);
    await f.request('/v1/auth/request-password-reset', { email: 'reader@example.test' }); await f.app.mailOutbox!.drain();
    assert.equal((await f.request('/v1/auth/reset-password', { token: f.mail.at(-1)!.token, newPassword: 'fresh recovered password fixture' })).status, 200);
    assert.equal((await f.request('/v1/auth/sign-in/email', { email: 'reader@example.test', password: 'fresh recovered password fixture' })).status, 200);
    assert.deepEqual(await (await f.request('/v1/identity')).json(), identity);
  } finally { await f.close(); }
});

test('restore rejects old stateless verification JWTs and accepts freshly issued verification', async () => {
  assert.equal(typeof api.restoreAccountDatabase, 'function');
  const f = await fixture(); try {
    await f.register(); const oldVerification = f.mail.at(-1)!; f.app.close(); await api.backupAccountDatabase(f.source, f.backup);
    await api.restoreAccountDatabase({ backupPath: f.backup, targetPath: f.target, currentAuthSecret: oldSecret, newAuthSecret: newSecret, custody: f.custody }); f.replace(f.open(f.target, newSecret));
    await f.app.handler(new Request(oldVerification.url));
    const db = new Database(f.target); assert.equal((db.prepare('SELECT emailVerified FROM user').get() as { emailVerified: number }).emailVerified, 0);
    await f.request('/v1/auth/send-verification-email', { email: 'reader@example.test' }); await f.app.mailOutbox!.drain(); await f.app.handler(new Request(f.mail.at(-1)!.url));
    assert.equal((db.prepare('SELECT emailVerified FROM user').get() as { emailVerified: number }).emailVerified, 1); db.close();
  } finally { await f.close(); }
});

for (const missing of ['assignment', 'account', 'key'] as const) test(`restore remains quarantined across restart for missing ${missing}`, async () => {
  assert.equal(typeof api.restoreAccountDatabase, 'function'); const f = await fixture(); try {
    if (missing === 'assignment') { await f.register(); await f.app.handler(new Request(f.mail.at(-1)!.url)); }
    if (missing === 'key') await f.verified();
    f.app.close(); await api.backupAccountDatabase(f.source, f.backup); f.replace(f.open());
    if (missing === 'account') await f.verified();
    if (missing === 'assignment') { await f.request('/v1/auth/sign-in/email', { email: 'reader@example.test', password }); await f.request('/v1/identity'); }
    f.app.close();
    const custody = missing === 'key' ? { ...f.custody, encryption: { activeKid: 'new', keys: { new: new Uint8Array(32).fill(8) } } } : f.custody;
    assert.equal((await api.restoreAccountDatabase({ backupPath: f.backup, targetPath: f.target, currentAuthSecret: oldSecret, newAuthSecret: newSecret, custody })).ready, false);
    for (let i = 0; i < 2; i++) assert.throws(() => f.open(f.target, newSecret, custody));
    await assert.rejects(api.reconcileAccountRestore(f.target, custody));
    const db = new Database(f.target); assert.throws(() => api.createIdentityStore(db, custody)); db.close();
    if (missing === 'key') { await api.reconcileAccountRestore(f.target, f.custody); f.replace(f.open(f.target, newSecret)); await f.app.ready(); }
  } finally { await f.close(); }
});

test('offline storage rotation rewraps existing identities and queued mail atomically', async () => {
  assert.equal(typeof api.rotateAccountStorageKey, 'function'); const f = await fixture(); try {
    const identity = await f.verified(); await f.request('/v1/auth/request-password-reset', { email: 'reader@example.test' }); f.app.close();
    const custody = { ...f.custody, encryption: { activeKid: 'new', keys: { ...f.custody.encryption.keys, new: new Uint8Array(32).fill(8) } } };
    const db = new Database(f.source); const before = db.prepare('SELECT encrypted_secret FROM author_identity').all();
    db.exec("CREATE TRIGGER reject_rotation BEFORE UPDATE ON account_mail_outbox BEGIN SELECT RAISE(ABORT, 'rotation failure'); END");
    await assert.rejects(api.rotateAccountStorageKey(f.source, custody)); assert.deepEqual(db.prepare('SELECT encrypted_secret FROM author_identity').all(), before); db.exec('DROP TRIGGER reject_rotation');
    await api.rotateAccountStorageKey(f.source, custody);
    for (const row of db.prepare('SELECT encrypted_secret AS ciphertext FROM author_identity UNION ALL SELECT payload FROM account_mail_outbox').all() as { ciphertext: string }[]) assert.equal(JSON.parse(Buffer.from(row.ciphertext.split('.')[0]!, 'base64url').toString()).kid, 'new'); db.close();
    f.replace(f.open(f.source, oldSecret, { ...custody, encryption: { activeKid: 'new', keys: { new: custody.encryption.keys.new } } })); await f.app.ready(); assert.deepEqual(await (await f.request('/v1/identity')).json(), identity); await f.app.mailOutbox!.drain(); assert.equal(f.mail.at(-1)!.kind, 'password-reset'); assert.equal(f.app.mailOutbox!.status().queued, 0);
  } finally { await f.close(); }
});

test('SQLite backup includes committed WAL contents without checkpointing the source', async () => {
  const f = await fixture(); try {
    f.app.close(); const db = new Database(f.source); db.pragma('journal_mode = WAL'); db.pragma('wal_autocheckpoint = 0');
    db.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, 0, 0)').run('wal-account', 'WAL', 'wal@example.test');
    await api.backupAccountDatabase(f.source, f.backup);
    const copy = new Database(f.backup); assert.equal((copy.prepare('SELECT id FROM user WHERE id = ?').get('wal-account') as { id: string }).id, 'wal-account'); copy.close(); db.close();
  } finally { await f.close(); }
});

test('failed key decryption or mail binding prevents all rotation writes', async () => {
  const f = await fixture(); try {
    await f.verified(); await f.request('/v1/auth/request-password-reset', { email: 'reader@example.test' }); f.app.close();
    const db = new Database(f.source); const before = db.prepare('SELECT * FROM author_identity').all();
    const missing = { ...f.custody, encryption: { activeKid: 'new', keys: { new: new Uint8Array(32).fill(8) } } };
    await assert.rejects(api.rotateAccountStorageKey(f.source, missing)); assert.deepEqual(db.prepare('SELECT * FROM author_identity').all(), before);
    db.prepare('UPDATE account_mail_outbox SET expires_at = expires_at + 1').run();
    await assert.rejects(api.rotateAccountStorageKey(f.source, f.custody)); assert.deepEqual(db.prepare('SELECT * FROM author_identity').all(), before); db.close();
  } finally { await f.close(); }
});

test('runtime encryption extras cannot override the root custody installation for mail or rotation', async () => {
  const f = await fixture(); try {
    await f.verified(); f.app.close();
    Object.assign(f.custody.encryption, { installationId: 'unexpected-runtime-extra' });
    f.replace(f.open()); await f.request('/v1/auth/request-password-reset', { email: 'reader@example.test' }); f.app.close();
    const db = new Database(f.source); const row = db.prepare('SELECT payload FROM account_mail_outbox').get() as { payload: string };
    assert.equal(JSON.parse(Buffer.from(row.payload.split('.')[0]!, 'base64url').toString()).installation, f.custody.installationId); db.close();
    await api.rotateAccountStorageKey(f.source, f.custody);
  } finally { await f.close(); }
});
