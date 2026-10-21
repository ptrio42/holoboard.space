import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request as requestHTTPS } from 'node:https';
import { createServer } from 'node:net';
import * as service from '../src/main.ts';
export async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'account-service-test-'));
  const port = await new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address() as {
        port: number;
      };
      s.close(() => resolve(a.port));
    });
  });
  const baseURL = `https://127.0.0.1:${port}`;
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  await writeFile(join(dir, 'secret'), 'test-only-private-auth-secret-for-service-42', { mode: 0o600 });
  await writeFile(join(dir, 'keyring.json'), JSON.stringify({ activeKid: 'one', keys: { one: '42'.repeat(32) } }), { mode: 0o600 });
  const config = { databasePath: join(dir, 'accounts.sqlite'), baseURL, trustedOrigins: [baseURL], returnURLs: [baseURL + '/complete'], installationId: 'service-fixture', inventoryPath: join(dir, 'inventory'), authSecretPath: join(dir, 'secret'), keyringPath: join(dir, 'keyring.json'), tls: { keyPath: join(dir, 'key.pem'), certPath: join(dir, 'cert.pem') }, listenHost: '127.0.0.1', port, explicitExportEnabled: true, developmentCapturePath: join(dir, 'mail.jsonl'), mailIntervalMs: 50, shutdownTimeoutMs: 3000 };
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  await import('node:fs/promises').then(fs => fs.chmod(join(dir, 'cert.pem'), 0o600));
  const ca = await readFile(join(dir, 'cert.pem'));
  let cookie = '';
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}, chunks?: Buffer[]) => new Promise<{
    status: number;
    headers: any;
    body: string;
  }>((resolve, reject) => {
    const r = requestHTTPS(baseURL + path, { ca, servername: 'localhost', agent: false, method: body === undefined && !chunks ? 'GET' : 'POST', headers: { origin: baseURL, ...(body === undefined && !chunks ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers } }, res => {
      let text = '';
      res.on('data', x => text += x);
      res.on('end', () => {
        for (const c of res.headers['set-cookie'] ?? []) {
          if (c.startsWith('__Secure-better-auth.session_token='))
            cookie = c.split(';')[0]!;
        }
        resolve({ status: res.statusCode!, headers: res.headers, body: text });
      });
    });
    r.on('error', reject);
    if (chunks)
      for (const chunk of chunks)
        r.write(chunk);
    else if (body !== undefined)
      r.write(JSON.stringify(body));
    r.end();
  });
  return { dir, path, config, request, readMail: async () => ((await readFile(config.developmentCapturePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))), cleanup: () => rm(dir, { recursive: true, force: true }) };
}
test('standalone configuration requires explicit fresh initialization and private files', async () => {
  assert.equal(typeof service.loadServiceConfiguration, 'function');
  const f = await setup();
  try {
    const config = await service.loadServiceConfiguration(f.path);
    await assert.rejects(service.startAccountService(config));
    await service.initializeService(config);
    await assert.rejects(service.initializeService(config));
    const running = await service.startAccountService(config);
    await running.stop();
    assert.equal((await stat(f.config.databasePath)).mode & 0o777, 0o600);
  }
  finally {
    await f.cleanup();
  }
});
test('real TLS service supports HTTP accounts and bounds hostile or streamed ingress', async () => {
  assert.equal(typeof service.loadServiceConfiguration, 'function');
  const f = await setup();
  let running: any;
  try {
    const config = await service.loadServiceConfiguration(f.path);
    await service.initializeService(config);
    running = await service.startAccountService(config);
    assert.equal((await f.request('/v1/auth/sign-up/email', { email: 'reader@example.test', password: 'test password for service', name: 'Reader' })).status, 202);
    let mail: any[] = [];
    for (let i = 0; i < 100; i++) {
      try {
        mail = await f.readMail();
        if (mail.length)
          break;
      }
      catch {
      }
      await new Promise(r => setTimeout(r, 20));
    }
    assert.equal(mail.length, 1);
    assert.equal((await stat(f.config.developmentCapturePath)).mode & 0o777, 0o600);
    assert.equal((await f.request(new URL(mail[0].url).pathname + new URL(mail[0].url).search)).status, 302);
    assert.equal((await f.request('/v1/auth/sign-in/email', { email: 'reader@example.test', password: 'test password for service' })).status, 200);
    const identity = JSON.parse((await f.request('/v1/identity')).body);
    assert.match(identity.publicKey, /^[a-f0-9]{64}$/);
    assert.equal((await f.request('/v1/identity/sign', { template: { kind: 1, created_at: 1700000000, content: 'private fixture', tags: [] } })).status, 200);
    assert.equal((await f.request('/v1/identity/export', { password: 'test password for service' })).status, 200);
    assert.equal((await f.request('/v1/auth/get-session', undefined, { host: 'hostile.test' })).status, 400);
    assert.equal((await f.request('/v1/auth/sign-out', {}, { origin: 'https://hostile.test' })).status, 403);
    const over = await f.request('/v1/auth/sign-out', undefined, {}, [Buffer.alloc(40000, 32), Buffer.alloc(40000, 32)]);
    assert.equal(over.status, 413);
    assert.ok(over.body.length < 1000);
    assert.equal((await f.request('/v1/auth/sign-out', {})).status, 200);
    assert.equal(JSON.parse((await f.request('/v1/auth/get-session')).body), null);
    await running.stop();
    running = await service.startAccountService(config);
    assert.equal((await f.request('/v1/auth/sign-in/email', { email: 'reader@example.test', password: 'test password for service' })).status, 200);
    assert.equal(JSON.parse((await f.request('/v1/identity')).body).publicKey, identity.publicKey);
    assert.equal((await f.request('/v1/auth/request-password-reset', { email: 'reader@example.test' })).status, 202);
    for (let i = 0; i < 100; i++) {
      mail = await f.readMail();
      if (mail.length > 1)
        break;
      await new Promise(r => setTimeout(r, 20));
    }
    const reset = mail.find(x => x.kind === 'password-reset');
    assert.ok(reset);
    assert.equal((await f.request('/v1/auth/reset-password', { token: reset.token, newPassword: 'new fixture password for service' })).status, 200);
    assert.equal((await f.request('/v1/identity')).status, 401);
    assert.equal((await f.request('/v1/auth/sign-in/email', { email: 'reader@example.test', password: 'test password for service' })).status, 401);
    assert.equal((await f.request('/v1/auth/sign-in/email', { email: 'reader@example.test', password: 'new fixture password for service' })).status, 200);
    assert.equal(JSON.parse((await f.request('/v1/identity')).body).publicKey, identity.publicKey);
  }
  finally {
    if (running)
      await running.stop();
    await f.cleanup();
  }
});
test('configuration and development capture reject unsafe private file settings', async () => {
  const f = await setup();
  try {
    await writeFile(f.path, JSON.stringify({ ...f.config, explicitExportEnabled: 'false' }), { mode: 0o600 });
    await assert.rejects(service.loadServiceConfiguration(f.path), { message: 'INVALID_SERVICE_CONFIGURATION' });
    await writeFile(f.path, JSON.stringify(f.config));
    await import('node:fs/promises').then(fs => fs.chmod(f.config.authSecretPath, 0o644));
    await assert.rejects(service.loadServiceConfiguration(f.path), { message: 'INVALID_SERVICE_CONFIGURATION' });
    const capture = service.createDevelopmentCapture(join(f.dir, 'unsafe-mail'));
    await writeFile(join(f.dir, 'unsafe-mail'), '', { mode: 0o644 });
    await assert.rejects(capture.send({ kind: 'verification', email: 'r@example.test', url: 'https://example.test', token: 'private', expiresAt: Date.now() + 1000 }, new AbortController().signal));
  }
  finally {
    await f.cleanup();
  }
});
test('shutdown reports an incomplete worker instead of closing the database under a stuck adapter', async () => {
  const f = await setup();
  let running: Awaited<ReturnType<typeof service.startAccountService>> | undefined;
  let release!: (v: void) => void;
  try {
    const config = await service.loadServiceConfiguration(f.path);
    await service.initializeService(config);
    delete config.developmentCapturePath;
    config.shutdownTimeoutMs = 50;
    config.account.mail = { send: () => new Promise<void>(resolve => {
        release = resolve;
      }) };
    running = await service.startAccountService(config);
    assert.equal((await f.request('/v1/auth/sign-up/email', { email: 'r@example.test', password: 'test password for stuck worker', name: 'R' })).status, 202);
    for (let i = 0; i < 100 && !release; i++)
      await new Promise(r => setTimeout(r, 10));
    assert.ok(release);
    await assert.rejects(running.stop(), { message: 'ACCOUNT_SHUTDOWN_INCOMPLETE' });
    release();
    await new Promise(r => setTimeout(r, 20));
    await running.stop();
  }
  finally {
    release?.();
    await f.cleanup();
  }
});
