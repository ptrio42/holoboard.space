import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { chromium } from 'playwright';
import { validateSignedEvent } from '@holoboard/accounts-client';
import { initializeService, loadServiceConfiguration } from '../../apps/service/dist/main.js';
import { createNodeAccountListener } from '@holoboard/accounts-server';

async function port() { const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const value = server.address().port; await new Promise(r => server.close(r)); return value; }
async function submit(page, id, fields = {}) { for (const [name, value] of Object.entries(fields)) await page.locator(`#${id} [name="${name}"]`).fill(value); await page.locator(`#${id} button[type=submit]`).click(); await page.waitForFunction(() => document.querySelector('#status').dataset.busy === 'false'); }
async function result(page) { return JSON.parse(await page.locator('#result').textContent()); }

test('real browser forms preserve identity, revoke remote sessions and keep private data out of storage', { timeout: 90000 }, async () => {
  const file = new URL('./server.mjs', import.meta.url);
  assert.ok(await readFile(file).then(() => true, () => false), 'a runnable web example is required');
  const { startWebExample, publicHandler } = await import(file.href);
  const directory = await mkdtemp(join(tmpdir(), 'account-browser-')); const installation = join(directory, 'installation');
  let browser, running, uiBridge, hostileBridge;
  let stage = 'setup';
  try {
    const apiPort = await port(), uiPort = await port(), hostilePort = await port();
    const apiOrigin = `https://127.0.0.1:${apiPort}`, uiOrigin = `https://127.0.0.1:${uiPort}`, hostileOrigin = `https://localhost:${hostilePort}`;
    execFileSync(process.execPath, ['examples/local-setup.mjs', installation, String(apiPort)], { stdio: 'pipe' });
    const configPath = join(installation, 'config.json'); const json = JSON.parse(await readFile(configPath, 'utf8'));
    json.basePath = '/custom/auth'; json.trustedOrigins = [apiOrigin, uiOrigin]; json.returnURLs = [`${uiOrigin}/complete`];
    await writeFile(configPath, JSON.stringify(json)); const config = await loadServiceConfiguration(configPath); await initializeService(config);
    running = await startWebExample(config);
    uiBridge = createNodeAccountListener({ baseURL: uiOrigin, tls: config.tls, handler: publicHandler(config) });
    hostileBridge = createNodeAccountListener({ baseURL: hostileOrigin, tls: config.tls, handler: publicHandler(config) });
    for (const [bridge, number] of [[uiBridge, uiPort], [hostileBridge, hostilePort]]) await new Promise((resolve, reject) => { bridge.listener.once('error', reject); bridge.listener.listen(number, '127.0.0.1', resolve); });
    const cert = new X509Certificate(config.tls.cert); const spki = createHash('sha256').update(cert.publicKey.export({ format: 'der', type: 'spki' })).digest('base64');
    browser = await chromium.launch({ executablePath: process.env.ACCOUNTS_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: [`--ignore-certificate-errors-spki-list=${spki}`, '--disable-background-networking'] });
    const first = await browser.newContext(), second = await browser.newContext();
    for (const context of [first, second]) await context.route('**/*', route => { const url = new URL(route.request().url()); return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort(); });
    stage = 'registration and login';
    const page = await first.newPage(), other = await second.newPage();
    const errors = []; page.on('console', message => { if (message.type() === 'log') errors.push(message.text()); });
    await page.goto(apiOrigin); await page.waitForFunction(() => document.querySelector('#status').dataset.busy === 'false'); assert.equal(await result(page), null);
    await page.goto(uiOrigin); await page.waitForFunction(() => document.querySelector('#status').dataset.busy === 'false');
    const email = 'browser-reader@example.test', password = 'browser fixture password 1234', replacement = 'browser recovered password 5678';
    await submit(page, 'register', { email, password, name: '<img src=x onerror=alert(1)>' }); assert.equal((await result(page)).accepted, true);
    async function mail(kind) { for (let i = 0; i < 100; i++) { try { const all = (await readFile(json.developmentCapturePath, 'utf8')).trim().split('\n').map(JSON.parse); const message = all.findLast(m => m.kind === kind); if (message) return message; } catch {} await new Promise(r => setTimeout(r, 40)); } throw new Error('No private capture'); }
    await submit(page, 'resend', { email }); assert.equal((await result(page)).accepted, true);
    await page.goto(`${uiOrigin}/complete?token=invalid-fixture-token`); await page.waitForFunction(() => !location.search); await submit(page, 'verify'); assert.equal(await page.locator('#status').textContent(), 'UNAUTHENTICATED');
    const verification = await mail('verification');
    await page.goto(`${uiOrigin}/complete?token=${encodeURIComponent(verification.token)}`); await page.waitForFunction(() => !location.search); await submit(page, 'verify'); assert.deepEqual(await result(page), { verified: true });
    await submit(page, 'login', { email, password }); assert.equal((await result(page)).user.emailVerified, true); assert.equal(await page.locator('#result img').count(), 0);
    await page.reload(); await page.waitForFunction(() => document.querySelector('#status').dataset.busy === 'false'); assert.equal((await result(page)).user.email, email);
    stage = 'sign and export';
    await submit(page, 'sign', { content: 'Exact <text>\nsecond line' }); const event = await result(page); validateSignedEvent(event, { kind: 1, created_at: event.created_at, content: 'Exact <text>\nsecond line', tags: [] }, event.pubkey);
    await submit(page, 'export', { password }); const exported = await result(page); assert.equal(exported.publicKey, event.pubkey); assert.ok(exported.nsec.startsWith('nsec1')); await page.locator('#clear-export').click(); assert.ok(!(await page.locator('#result').textContent()).includes('nsec1'));
    const cookies = await first.cookies(apiOrigin); const session = cookies.find(c => c.name === '__Secure-better-auth.session_token'); assert.ok(session); assert.equal(session.secure, true); assert.equal(session.httpOnly, true); assert.equal(session.sameSite, 'Lax'); assert.equal(session.domain, '127.0.0.1'); assert.ok(!(await page.evaluate(() => document.cookie)).includes(session.value));
    stage = 'password recovery and revocation';
    await other.goto(uiOrigin); await other.waitForFunction(() => document.querySelector('#status').dataset.busy === 'false'); await submit(other, 'login', { email, password });
    await submit(page, 'recovery', { email }); const reset = await mail('password-reset');
    await page.goto(reset.url); await page.waitForFunction(() => !location.search); await submit(page, 'reset', { password: replacement });
    await submit(other, 'sign', { content: 'Revoked' }); assert.equal(await other.locator('#status').textContent(), 'UNAUTHENTICATED');
    await submit(page, 'login', { email, password: replacement }); await submit(page, 'sign', { content: 'Recovered' }); assert.equal((await result(page)).pubkey, event.pubkey);
    stage = 'asset boundaries and private storage';
    for (const path of ['/config.json', '/mail.jsonl', '/server.mjs', '/node_modules/', '/../../private/config.json']) { const code = await page.evaluate(async path => (await fetch(path, { cache: 'no-store' })).status, path); assert.equal(code, 404); }
    const storage = await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, caches: await caches.keys(), workers: (await navigator.serviceWorker.getRegistrations()).length, databases: await indexedDB.databases() })); assert.deepEqual(storage, { local: 0, session: 0, caches: [], workers: 0, databases: [] });
    stage = 'hostile origin';
    const hostile = await first.newPage(); await hostile.goto(hostileOrigin); await hostile.waitForFunction(() => document.querySelector('#status').dataset.busy === 'false'); assert.equal(await hostile.locator('#status').textContent(), 'NETWORK_ERROR');
    const denied = await hostile.evaluate(async api => { try { const r = await fetch(api + '/custom/auth/sign-out', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' }); return r.status; } catch { return 'blocked'; } }, apiOrigin); assert.equal(denied, 'blocked');
    await submit(page, 'session'); assert.equal((await result(page)).user.email, email);
    stage = 'logout';
    await submit(page, 'logout'); await page.reload(); await page.waitForFunction(() => document.querySelector('#status').dataset.busy === 'false'); assert.equal(await result(page), null);
    assert.deepEqual(errors, []);
  } catch { throw new Error(`Browser acceptance failed at ${stage}`); } finally {
    await browser?.close(); await uiBridge?.close(); await hostileBridge?.close(); await running?.stop(); await rm(directory, { recursive: true, force: true });
  }
});
