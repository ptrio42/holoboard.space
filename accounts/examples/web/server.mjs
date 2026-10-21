import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAccountServer, createNodeAccountListener } from '@holoboard/accounts-server';
import { createDevelopmentCapture, loadServiceConfiguration, serveAccountApplication } from '../../apps/service/dist/main.js';

/** Exact public asset allowlist. No directory serving, source maps or private capture route. */
export function publicHandler(config) {
  return async request => {
    const path = new URL(request.url).pathname;
    const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
      'content-security-policy': `default-src 'none'; script-src 'self'; connect-src 'self' ${config.account.baseURL}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` };
    if (request.method !== 'GET') return new Response(null, { status: 404, headers });
    if (path === '/runtime.json') return Response.json({ baseURL: config.account.baseURL, authBasePath: config.account.basePath ?? '/v1/auth' }, { headers });
    const asset = path === '/' || path === '/complete' ? ['index.html', 'text/html; charset=utf-8'] : path === '/app.js' ? ['dist/app.js', 'text/javascript; charset=utf-8'] : undefined;
    if (!asset) return new Response(null, { status: 404, headers });
    return new Response(await readFile(new URL(asset[0], import.meta.url)), { headers: { ...headers, 'content-type': asset[1] } });
  };
}
export async function startWebExample(config) {
  const app = createAccountServer({ ...config.account, ...(config.developmentCapturePath ? { mail: createDevelopmentCapture(config.developmentCapturePath) } : {}) });
  const servePublic = publicHandler(config);
  const publicPaths = new Set(['/', '/complete', '/app.js', '/runtime.json']);
  const handler = (request, context) => publicPaths.has(new URL(request.url).pathname) ? servePublic(request) : app.handler(request, context);
  const bridge = createNodeAccountListener({ handler, baseURL: config.account.baseURL, tls: config.tls });
  return serveAccountApplication(config, app, bridge);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = await loadServiceConfiguration(process.argv[2]);
    const running = await startWebExample(config);
    process.stdout.write(`ACCOUNT_WEB_LISTENING ${running.baseURL}\n`);
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void running.stop().then(() => process.stdout.write('ACCOUNT_STOPPED\n'), () => { process.stderr.write('ACCOUNT_SHUTDOWN_INCOMPLETE\n'); process.exit(1); });
    });
  } catch { process.stderr.write('ACCOUNT_WEB_FAILED\n'); process.exitCode = 1; }
}
