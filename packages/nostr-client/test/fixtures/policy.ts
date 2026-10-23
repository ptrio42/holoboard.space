import type { ContentMode, ContentPolicy, HostIdentity } from './ports';
import type { QueryResult } from '../../src/core/transport/nostrTransport';

export function fixtureRelay(value: string): string | undefined {
  if (value.length > 2048) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port ||
        url.username || url.password || url.hash || url.search || url.pathname !== '/') return;
    return url.toString().replace(/\/$/, '');
  } catch { return; }
}
export function cancelledQuery(relays: readonly string[]): QueryResult {
  return { events: [], sources: {}, relays: Object.fromEntries(relays.map(url => [url, 'cancelled' as const])), complete: false };
}
export interface FixturePolicy extends ContentPolicy {
  configuredRelay(url: string): boolean;
  mediaAllowed(url: string): boolean;
  setMode(mode: ContentMode): void;
  dispose(): void;
}
/** Explicit fixture addresses are immutable. A mode change never starts work. */
export function createContentPolicy(localRelay: string, networkRelay?: string, mediaUrls: readonly string[] = []): FixturePolicy {
  const local = fixtureRelay(localRelay), network = networkRelay === undefined ? undefined : fixtureRelay(networkRelay);
  if (!local || local !== localRelay || networkRelay !== undefined && (!network || network !== networkRelay || network === local)) {
    throw new TypeError('Configure distinct canonical loopback fixture relays.');
  }
  const media = new Set(mediaUrls.map(value => {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port ||
        url.username || url.password || url.hash || url.search || url.href !== value) throw new TypeError('Configure exact owned loopback media URLs.');
    return value;
  }));
  let mode: ContentMode = 'community', generation = 0, disposed = false;
  const listeners = new Set<() => void>();
  const policy: FixturePolicy = {
    get mode() { return mode; }, get generation() { return generation; },
    configuredRelay: url => url === local || !!network && url === network,
    relayAllowed: url => !disposed && (url === local || mode === 'network' && !!network && url === network),
    mediaAllowed: url => !disposed && media.has(url),
    onChange(listener) { if (disposed) throw new Error('Policy disposed.'); listeners.add(listener); return () => { listeners.delete(listener); }; },
    setMode(next) {
      if (disposed) throw new Error('Policy disposed.');
      if (next !== 'community' && next !== 'network') throw new TypeError('Unknown content mode');
      if (mode === next) return;
      mode = next; generation++; listeners.forEach(listener => listener());
    },
    dispose() { if (disposed) return; disposed = true; generation++; listeners.forEach(listener => listener()); listeners.clear(); },
  };
  return policy;
}

export function hostNamespace(identity: HostIdentity) {
  return `client-reuse:${JSON.stringify([identity.appId, identity.principal, identity.localRelay])}`;
}
