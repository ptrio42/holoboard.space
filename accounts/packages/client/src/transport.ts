/** Minimal transport contract, independent of DOM and native storage APIs. */
export interface TransportRequest {
  url: string;
  method: 'GET' | 'POST';
  body?: string;
  timeoutMs: number;
  maxResponseBytes: number;
}
export interface TransportResponse {
  status: number;
  body: string;
  retryAfter?: string;
}
export type AccountTransport = (request: TransportRequest) => Promise<TransportResponse>;
export type ErrorCode = 'INVALID_INPUT' | 'UNAUTHENTICATED' | 'EMAIL_UNVERIFIED' | 'PERMISSION_DENIED' | 'IDENTITY_UNAVAILABLE' | 'TEMPORARILY_UNAVAILABLE' | 'REQUEST_TOO_LARGE' | 'REQUEST_TIMEOUT' | 'RATE_LIMITED' | 'NOT_FOUND' | 'UNSUPPORTED_MEDIA_TYPE' | 'REQUEST_HEADERS_TOO_LARGE' | 'NETWORK_ERROR' | 'INVALID_RESPONSE' | 'INVALID_SIGNATURE' | 'STALE_AUTH_STATE';
export class AccountClientError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  constructor(code: ErrorCode, status = 0, retryAfterSeconds?: number) {
    super(code);
    this.name = 'AccountClientError';
    this.code = code;
    this.status = status;
    this.retryable = status === 429 || status === 503 || ['NETWORK_ERROR', 'REQUEST_TIMEOUT'].includes(code);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const point of value) {
    const n = point.codePointAt(0)!;
    bytes += n <= 0x7f ? 1 : n <= 0x7ff ? 2 : n <= 0xffff ? 3 : 4;
  }
  return bytes;
}
interface Signal {
  readonly aborted: boolean;
}
interface Controller {
  signal: Signal;
  abort(): void;
}
interface Reader {
  read(): Promise<{
    done: boolean;
    value?: Uint8Array;
  }>;
  cancel(): Promise<unknown>;
}
export interface FetchLike {
  (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    credentials: 'include';
    redirect: 'manual';
    cache: 'no-store';
    signal: Signal;
  }): Promise<{
    status: number;
    type?: string;
    headers: {
      get(name: string): string | null;
    };
    body: {
      getReader(): Reader;
    } | null;
  }>;
}
interface Runtime {
  fetch?: FetchLike;
  AbortController: new () => Controller;
  TextDecoder: new (encoding: string, options: {
    fatal: boolean;
  }) => {
    decode(value: Uint8Array): string;
  };
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const runtime = globalThis as unknown as Runtime;
export async function withClientDeadline<T>(operation: () => Promise<T>, milliseconds: number, cancel?: () => void): Promise<T> {
  let timer: unknown;
  try {
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = runtime.setTimeout(() => {
          cancel?.();
          reject(new AccountClientError('REQUEST_TIMEOUT'));
        }, milliseconds);
      })]);
  }
  finally {
    runtime.clearTimeout(timer);
  }
}
/** Browser cookies stay in the browser. A native application supplies its own transport instead. */
export function createWebTransport(options: {
  fetch?: FetchLike;
  origin?: string;
} = {}): AccountTransport {
  const fetcher = options.fetch ?? runtime.fetch;
  if (!fetcher)
    throw new AccountClientError('INVALID_INPUT');
  return async (request) => {
    const controller = new runtime.AbortController();
    return withClientDeadline(async () => {
      let reader: Reader | undefined;
      try {
        const response = await fetcher(request.url, { method: request.method, headers: {
            ...(request.body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.origin ? { origin: options.origin } : {}),
          }, ...(request.body === undefined ? {} : { body: request.body }), credentials: 'include', redirect: 'manual', cache: 'no-store', signal: controller.signal });
        // Fetch deliberately hides cross-origin redirect details. Verification has no autologin.
        if (response.type === 'opaqueredirect')
          return { status: 302, body: '' };
        const declared = response.headers.get('content-length');
        if (declared && (!/^\d+$/.test(declared) || Number(declared) > request.maxResponseBytes))
          throw new AccountClientError('INVALID_RESPONSE');
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        reader = response.body?.getReader();
        if (reader)
          while (true) {
            const chunk = await reader.read();
            if (chunk.done)
              break;
            if (!chunk.value)
              continue;
            bytes += chunk.value.byteLength;
            if (bytes > request.maxResponseBytes)
              throw new AccountClientError('INVALID_RESPONSE');
            chunks.push(chunk.value);
          }
        const joined = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
          joined.set(chunk, offset);
          offset += chunk.length;
        }
        const body = new runtime.TextDecoder('utf-8', { fatal: true }).decode(joined);
        const retryAfter = response.headers.get('retry-after');
        return { status: response.status, body, ...(retryAfter === null ? {} : { retryAfter }) };
      }
      catch (error) {
        controller.abort();
        if (reader)
          void reader.cancel().catch(() => {
          });
        throw error instanceof AccountClientError ? error : new AccountClientError('NETWORK_ERROR');
      }
    }, request.timeoutMs, () => controller.abort());
  };
}
