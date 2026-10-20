import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeError, object } from './contract.ts';
import { ReviewBackend } from './review-backend.ts';
import type { ReviewAction, ReviewClient } from './review-backend.ts';
import { REVIEW_STYLE, reviewError, reviewPage } from './review-page.ts';

export interface ReviewServerOptions { client: ReviewClient; port: number }
const assets = {
  '/assets/pixel.woff2': { path: new URL('../../web/src/assets/fonts/PressStart2P-Regular.woff2', import.meta.url), mime: 'font/woff2' },
  '/assets/mark.svg': { path: new URL('../../web/src/assets/holoboard-mark.svg', import.meta.url), mime: 'image/svg+xml' },
};

export function createReviewServer(options: ReviewServerOptions): Server {
  const csrf = randomBytes(32).toString('hex');
  const hosts = new Set(['127.0.0.1', 'localhost'].map(h => `${h}:${options.port}`));
  const respond = (res: ServerResponse, status: number, body: string | Buffer, mime = 'text/html; charset=utf-8'): void => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writeHead(status, { 'Content-Type': mime, 'Content-Length': bytes.length, 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    res.end(bytes);
  };
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const address = options.port === 0 ? server.address() : null;
    if (address && typeof address !== 'string') for (const h of ['127.0.0.1', 'localhost']) hosts.add(`${h}:${address.port}`);
    if (!req.headers.host || !hosts.has(req.headers.host)) { respond(res, 403, reviewError('This review panel is available on loopback only.')); return; }
    const origin = 'http://' + req.headers.host;
    const url = new URL(req.url ?? '/', origin);
    if (url.origin !== origin) { respond(res, 403, reviewError('Invalid request origin.')); return; }
    if (req.method === 'GET') {
      if (url.pathname === '/style.css') { respond(res, 200, REVIEW_STYLE, 'text/css'); return; }
      const asset = assets[url.pathname as keyof typeof assets];
      if (asset) { respond(res, 200, await readFile(asset.path), asset.mime); return; }
      if (url.pathname !== '/') { respond(res, 404, reviewError('Page not found.')); return; }
      const offset = Number(url.searchParams.get('offset') ?? '0');
      if (!Number.isSafeInteger(offset) || offset < 0) { respond(res, 400, reviewError('Invalid queue page.')); return; }
      respond(res, 200, reviewPage(await options.client.snapshot(offset), csrf, url.searchParams.get('result') ?? ''));
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/actions') { respond(res, 405, reviewError('Unsupported action.')); return; }
    if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/x-www-form-urlencoded'
      || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
      respond(res, 403, reviewError('Submit review actions from this panel.')); return;
    }
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk); length += bytes.length;
      if (length > 4096) { respond(res, 413, reviewError('Review action is too large.')); return; }
      chunks.push(bytes);
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const supplied = Buffer.from(form.get('csrf') ?? ''); const expected = Buffer.from(csrf);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { respond(res, 403, reviewError('This form has expired. Refresh the queue.')); return; }
    let action: ReviewAction;
    if (form.get('action') === 'set_review') {
      const value = form.get('review_required');
      if (!['true', 'false'].includes(value ?? '') || (value === 'false' && form.get('confirm_auto') !== 'yes')) { respond(res, 400, reviewError('Confirm automatic rewards before turning review off.')); return; }
      action = { action: 'set_review', review_required: value === 'true' };
    } else {
      const name = form.get('action'), note = form.get('note_id') ?? '', review = form.get('review_id') ?? '';
      if (!['approve', 'reject'].includes(name ?? '') || !/^[a-f0-9]{64}$/.test(note) || !/^[a-f0-9]{64}$/.test(review)) { respond(res, 400, reviewError('Invalid review action.')); return; }
      if (name === 'reject') action = { action: 'reject', note_id: note, review_id: review };
      else {
        const reward = Number(form.get('reward_sats'));
        if (![21, 100, 500].includes(reward)) { respond(res, 400, reviewError('Invalid proposed reward.')); return; }
        action = { action: 'approve', note_id: note, review_id: review, reward_sats: reward };
      }
    }
    const result = await options.client.act(action);
    const notice = action.action === 'set_review' ? action.review_required ? 'review_on' : 'review_off'
      : action.action === 'reject' ? 'rejected' : object(result) && result.dry_run === true ? 'preview_approved' : 'approved';
    res.writeHead(303, { Location: '/?result=' + notice, 'Cache-Control': 'no-store' }); res.end();
  };
  const server = createServer((req, res) => { void handle(req, res).catch(error => {
    // Only fixed operator messages reach the browser; backend URLs, tokens and
    // provider errors are never rendered or logged.
    const conflict = error instanceof SafeError && error.message === 'backend_http_409';
    respond(res, conflict ? 409 : 503, reviewError(conflict
      ? 'This item changed, expired, or the current fund limits prevent approval. Refresh the queue before deciding again.'
      : 'The review backend is unavailable. No successful review was confirmed. Refresh to check its current state.'));
  }); });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return server;
}

export async function startReview(env: NodeJS.ProcessEnv = process.env): Promise<Server> {
  const token = env.CURATOR_REVIEW_TOKEN, backend = env.CURATOR_BACKEND_URL;
  if (!token || !backend) throw new SafeError('explicit_review_token_and_backend_required');
  if (token === env.CURATOR_TOKEN || token === env.ADMIN_TOKEN || token.length < 32) throw new SafeError('separate_review_token_required');
  const port = Number(env.CURATOR_REVIEW_PORT ?? '4790');
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new SafeError('invalid_review_port');
  const server = createReviewServer({ client: new ReviewBackend(backend, token), port });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  process.stdout.write(`Private discovery review: http://127.0.0.1:${port}\n`);
  const close = (): void => { server.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startReview().catch(error => {
    process.stderr.write(JSON.stringify({ status: error instanceof SafeError ? error.message : 'review_server_failed' }) + '\n');
    process.exitCode = 1;
  });
}
