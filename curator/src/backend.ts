import { SafeError, parseBatch, object } from './contract.ts';
import type { Batch, Payload } from './contract.ts';
export function backendOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new SafeError('invalid_backend_url'); }
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !local)) throw new SafeError('backend_requires_https_or_loopback_origin');
  return url.origin;
}
export class Backend {
  origin: string; #token: string; #timeout: number;
  constructor(origin: string, token: string, timeoutMs = 20_000) {
    this.origin = backendOrigin(origin); this.#token = token; this.#timeout = timeoutMs;
    if (!token || /[\s\x00-\x1f\x7f]/.test(token) || token.length > 4096) throw new SafeError('invalid_curator_token');
  }
  protected async request(path: string, payload?: unknown): Promise<unknown> {
    try {
      const res = await fetch(this.origin + path, {
        method: payload ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(this.#timeout),
        headers: { authorization: 'Bearer ' + this.#token, ...(payload ? { 'content-type': 'application/json' } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      if (!res.ok) { await res.body?.cancel(); throw new SafeError('backend_http_' + res.status); }
      if (!res.body) throw new SafeError('backend_empty_response');
      const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 8_000_000) throw new SafeError('backend_response_too_large');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new SafeError('backend_invalid_json'); }
    } catch (e) {
      if (e instanceof SafeError) throw e;
      throw new SafeError('backend_request_failed');
    }
  }
  async candidates(): Promise<Batch> { return parseBatch(await this.request('/api/curator/candidates')); }
  async submit(payload: Payload): Promise<void> {
    const r = await this.request('/api/curator/decisions', payload);
    if (!object(r) || r.run_id !== payload.run_id || !['dry_run', 'active', 'disabled'].includes(String(r.mode)) || !Array.isArray(r.published) || !Array.isArray(r.proposed) || !Array.isArray(r.rejected)) throw new SafeError('backend_invalid_receipt');
  }
}
