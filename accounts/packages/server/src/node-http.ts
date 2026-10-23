import { createServer } from 'node:https';
import type { ServerOptions } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AccountRequestHandler } from './account-routes.ts';
/** One bounded TLS bridge for standalone and embedding integrations. No proxy headers are trusted. */
export function createNodeAccountListener(options: {
  handler: AccountRequestHandler;
  baseURL: string;
  tls: ServerOptions;
}) {
  const origin = new URL(options.baseURL);
  if (origin.protocol !== 'https:' || origin.origin !== options.baseURL)
    throw new Error('INVALID_LISTENER_CONFIGURATION');
  let stopping = false;
  let active = 0;
  function fail(response: ServerResponse, status: number, code: string) {
    if (response.headersSent)
      return;
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'connection': 'close' });
    response.end(JSON.stringify({ error: { code, message: code, retryable: status === 503 } }));
  }
  async function handle(incoming: IncomingMessage, outgoing: ServerResponse) {
    active++;
    try {
      if (stopping) {
        fail(outgoing, 503, 'TEMPORARILY_UNAVAILABLE');
        return;
      }
      if (incoming.headers.host !== origin.host || !incoming.url?.startsWith('/') || incoming.url.startsWith('//') || incoming.url.length > 8192) {
        fail(outgoing, 400, 'INVALID_INPUT');
        return;
      }
      if (incoming.rawHeaders.filter((_, i) => i % 2 === 0 && incoming.rawHeaders[i]!.toLowerCase() === 'host').length !== 1) {
        fail(outgoing, 400, 'INVALID_INPUT');
        return;
      }
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2)
        headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
      let bytes = 0;
      const chunks: Buffer[] = [];
      if (Number(incoming.headers['content-length'] ?? 0) > 65536) {
        fail(outgoing, 413, 'REQUEST_TOO_LARGE');
        return;
      }
      const body = await new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          incoming.pause();
          reject(new Error('REQUEST_TIMEOUT'));
        }, 5000);
        const cleanup = () => {
          clearTimeout(timer);
          incoming.off('data', data);
          incoming.off('end', end);
          incoming.off('error', error);
          incoming.off('aborted', abort);
        };
        const data = (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 65536) {
            cleanup();
            incoming.pause();
            reject(new Error('REQUEST_TOO_LARGE'));
          }
          else
            chunks.push(chunk);
        };
        const end = () => {
          cleanup();
          resolve(Buffer.concat(chunks));
        };
        const error = () => {
          cleanup();
          reject(new Error('INVALID_INPUT'));
        };
        const abort = () => {
          cleanup();
          reject(new Error('INVALID_INPUT'));
        };
        incoming.on('data', data);
        incoming.once('end', end);
        incoming.once('error', error);
        incoming.once('aborted', abort);
      }).catch((error: unknown) => {
        const code = error instanceof Error ? error.message : 'INVALID_INPUT';
        fail(outgoing, code === 'REQUEST_TOO_LARGE' ? 413 : code === 'REQUEST_TIMEOUT' ? 408 : 400, code);
        return null;
      });
      if (body === null)
        return;
      if ((incoming.method === 'GET' || incoming.method === 'HEAD') && body.length) {
        fail(outgoing, 400, 'INVALID_INPUT');
        return;
      }
      const result = await options.handler(new Request(options.baseURL + incoming.url, { method: incoming.method ?? 'GET', headers, ...(incoming.method === 'GET' || incoming.method === 'HEAD' ? {} : { body }) }), { peerAddress: incoming.socket.remoteAddress ?? '' });
      if (outgoing.destroyed)
        return;
      outgoing.statusCode = result.status;
      for (const [key, value] of result.headers)
        if (key !== 'set-cookie')
          outgoing.setHeader(key, value);
      const cookies = result.headers.getSetCookie();
      if (cookies.length)
        outgoing.setHeader('set-cookie', cookies);
      outgoing.setHeader('cache-control', 'no-store');
      outgoing.end(Buffer.from(await result.arrayBuffer()));
    }
    catch {
      fail(outgoing, 503, 'TEMPORARILY_UNAVAILABLE');
    }
    finally {
      active--;
    }
  }
  const listener = createServer({ ...options.tls, maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 5000, keepAliveTimeout: 1000, connectionsCheckingInterval: 1000 }, (request, response) => {
    void handle(request, response);
  });
  listener.maxRequestsPerSocket = 100;
  listener.maxConnections = 32;
  listener.setTimeout(16000, socket => socket.destroy());
  listener.on('clientError', (_error, socket) => {
    if (socket.writable)
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n');
  });
  return { listener,
    async close(timeoutMs = 10000) {
      stopping = true;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          listener.closeAllConnections();
          reject(new Error('ACCOUNT_SHUTDOWN_TIMEOUT'));
        }, timeoutMs);
        listener.close((error) => {
          clearTimeout(timer);
          if (error || active)
            reject(new Error('ACCOUNT_SHUTDOWN_INCOMPLETE'));
          else
            resolve();
        });
        listener.closeIdleConnections();
      });
    },
  };
}
