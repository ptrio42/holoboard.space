export class AccountError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}

export interface RequestLimit { maxRequests: number; windowMs: number }

export function validateLimit(limit: RequestLimit): RequestLimit {
  if (!Number.isInteger(limit.maxRequests) || limit.maxRequests < 1 || limit.maxRequests > 10000 ||
      !Number.isInteger(limit.windowMs) || limit.windowMs < 1000 || limit.windowMs > 3600000) {
    throw new Error("Invalid account request limit");
  }
  return limit;
}

/** Active entries are never evicted, so changing keys cannot bypass the memory bound. */
export function createLimiter(limit: RequestLimit, maxEntries = 1024) {
  validateLimit(limit);
  const entries = new Map<string, { count: number; until: number }>();
  return (key: string): void => {
    const now = Date.now();
    for (const [id, entry] of entries) if (entry.until <= now) entries.delete(id);
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= maxEntries) throw new AccountError("RATE_LIMITED", 429);
      entry = { count: 0, until: now + limit.windowMs };
      entries.set(key, entry);
    }
    if (++entry.count > limit.maxRequests) throw new AccountError("RATE_LIMITED", 429);
  };
}

export function createCapacity(maximum: number) {
  let active = 0;
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active >= maximum) throw new AccountError("TEMPORARILY_UNAVAILABLE", 503);
    active++;
    try { return await operation(); } finally { active--; }
  };
}

/** The underlying operation keeps its capacity slot until it actually settles. */
export async function withDeadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AccountError("TEMPORARILY_UNAVAILABLE", 503)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export async function readBoundedBody(body: ReadableStream<Uint8Array> | null, maximum = 65536, timeoutMs = 5000): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new AccountError("REQUEST_TIMEOUT", 408)); }, timeoutMs);
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) throw new AccountError("REQUEST_TOO_LARGE", 413);
      chunks.push(next.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
