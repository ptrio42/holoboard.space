import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
const log = await readFile(process.argv[2], 'utf8');
const evidence = process.argv[3] ?? await mkdtemp(path.join(os.tmpdir(), 'nostr-client-packed-browser-'));
const port = Number(process.env.NOSTR_CLIENT_TEST_PORT ?? 4392);
const origin = `http://127.0.0.1:${port}`;
const report = JSON.parse(log.trim().split('\n').at(-1));
const dist = path.join(report.fixture, 'dist');
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin);
    const target = path.resolve(dist, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (path.relative(dist, target).startsWith('..')) { response.writeHead(403).end(); return; }
    const body = await readFile(target);
    const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png' };
    response.writeHead(200, { 'content-type': types[path.extname(target)] || 'application/octet-stream', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'" }).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
let browser;
const results = [];
try {
  browser = await chromium.launch({ channel: process.env.NOSTR_CLIENT_BROWSER_CHANNEL ?? 'chrome', headless: true });
  for (const width of [1440, 390]) for (const theme of ['default', 'alternate']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [], external = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { external.push(url.href); return route.abort(); }
      return route.continue();
    });
    await page.goto(`${origin}/?${theme}`);
    const field = page.getByRole('textbox', { name: 'Note text', exact: true });
    await expect(field).toBeVisible();
    await expect(field).toHaveAttribute('placeholder', 'Write a note...');
    const fileInput = page.getByLabel('Choose attachments');
    const box = await fileInput.boundingBox();
    assert(box && box.width <= 1 && box.height <= 1);
    const metrics = await page.locator('[data-utility]').evaluate(element => {
      const style = getComputedStyle(element); return { padding: style.paddingTop, size: style.fontSize };
    });
    assert.equal(metrics.padding, '16px'); assert.equal(metrics.size, '14px');
    const labelFont = await page.getByRole('tab', { name: 'Write', exact: true }).evaluate(element => getComputedStyle(element).fontFamily);
    assert(labelFont.includes(theme === 'default' ? 'monospace' : 'serif'));
    assert.equal(await page.locator('[data-host-responsive]').isVisible(), width >= 640);
    await expect(page.locator('[data-media-case="image-only"] a')).toHaveAttribute('href', 'https://media.example/image-only.png');
    await expect(page.locator('[data-media-case="tag-only"] a')).toHaveAttribute('href', 'https://media.example/tag-only-image');
    assert.equal(await page.locator('img,video').count(), 0);
    await page.evaluate(() => window.fixtureSetMedia(true));
    await expect(page.locator('[data-media-case="mixed"] img')).toHaveCount(1);
    await page.getByRole('button', { name: 'Open image 1 of 1', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const overlay = await dialog.evaluate(element => ({ position: getComputedStyle(element.parentElement).position, display: getComputedStyle(element.parentElement).display }));
    assert.equal(overlay.position, 'fixed'); assert.equal(overlay.display, 'flex');
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.evaluate(() => window.fixtureSetMedia(false));
    await expect(page.locator('img,video')).toHaveCount(0);
    await expect(page.locator('[data-media-case="mixed"] a')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Attach files', exact: true })).toBeDisabled();
    await page.evaluate(() => {
      window.fixtureObjectUrls = 0;
      URL.createObjectURL = () => { window.fixtureObjectUrls++; return 'blob:unexpected'; };
      const field = document.querySelector('textarea');
      const data = new DataTransfer(); data.items.add(new File(['x'], 'unavailable.png', { type: 'image/png' }));
      field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      field.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await expect(page.getByRole('alert')).toContainText('File uploads are unavailable');
    assert.equal(await page.evaluate(() => window.fixtureObjectUrls), 0);
    assert.equal(await page.getByRole('list', { name: 'Selected files' }).count(), 0);
    await field.fill('Preserved text without upload capability.');
    await field.press('Control+Enter');
    assert.equal(await page.evaluate(() => window.fixtureReviews), 1);
    const overflow = await page.evaluate(() => [...document.querySelectorAll('*')].filter(element => element.getBoundingClientRect().right > innerWidth + 1).map(element => ({ tag: element.tagName, classes: element.className, width: element.getBoundingClientRect().width, right: element.getBoundingClientRect().right, boxSizing: getComputedStyle(element).boxSizing })));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, JSON.stringify({ width, theme, overflow }));
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    const screenshot = path.join(evidence, `packed-${theme}-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    results.push({ width, theme, metrics, labelFont, fileInput: { width: box.width, height: box.height }, externalRequests: external.length, screenshot });
    await context.close();
  }
  await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ archiveIntegrity: report.integrity, passed: results.length, results }, null, 2));
  console.log(JSON.stringify({ passed: results.length, archiveIntegrity: report.integrity, evidence }));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
