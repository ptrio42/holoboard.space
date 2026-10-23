import { createNostrTransport } from './nostrTransport';
import { canonicalRelay } from './relayUrl';
import { cancelledQuery } from './cancelledQuery';
import type { ContentPolicy } from '../ports';

export interface PublicReadTransportOptions {
  readonly relays: readonly string[];
  readonly policy: ContentPolicy;
  readonly relayAllowed?: (url: string) => boolean;
}
export function relayAdmission(options: PublicReadTransportOptions) {
  const configured = new Set(options.relays.map(value => {
    const url = canonicalRelay(value);
    if (!url || url !== value || !options.policy.configuredRelay(url)) throw new TypeError('Configure canonical relay URLs admitted by the host.');
    return url;
  }));
  return (values: string[], limit = 12) => [...new Set(values.map(canonicalRelay).filter((url): url is string =>
    !!url && configured.has(url) && options.policy.relayAllowed(url) && (options.relayAllowed?.(url) ?? true)))].slice(0, Math.min(limit, 12));
}
/** Anonymous public reads never construct a signer or expose a publication method. */
export function createPublicReadTransport(options: PublicReadTransportOptions) {
  const candidates = relayAdmission(options);
  const reads = createNostrTransport({ candidates });
  const monitors = new Map<{ close(): void }, string>();
  const reconcile = () => {
    for (const [handle, url] of monitors) if (!candidates([url]).length) { handle.close(); monitors.delete(handle); }
    reads.reconcile();
  };
  const unsubscribe = options.policy.onChange(reconcile);
  return {
    queryNostr: (async (filter, urls, queryOptions = {}) => {
      const generation = options.policy.generation;
      if (urls.some(url => !candidates([url]).length)) return cancelledQuery(urls);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      const unlisten = options.policy.onChange(cancel);
      queryOptions.signal?.addEventListener('abort', cancel, { once: true });
      if (queryOptions.signal?.aborted) cancel();
      try {
        const result = await reads.queryNostr(filter, urls, { ...queryOptions, signal: controller.signal });
        return controller.signal.aborted || generation !== options.policy.generation ? cancelledQuery(urls) : result;
      } finally { unlisten(); queryOptions.signal?.removeEventListener('abort', cancel); }
    }) as typeof reads.queryNostr,
    monitorRelay: ((url, onStatus) => {
      if (!candidates([url]).length) return { retry() {}, close() {} };
      const original = reads.monitorRelay(url, onStatus);
      let closed = false;
      const handle = {
        retry() { if (!closed && candidates([url]).length) original.retry(); },
        close() { if (closed) return; closed = true; original.close(); monitors.delete(handle); },
      };
      monitors.set(handle, url);
      return handle;
    }) as typeof reads.monitorRelay,
    reconcile,
    dispose() { unsubscribe(); for (const handle of monitors.keys()) handle.close(); reads.dispose(); },
  };
}
