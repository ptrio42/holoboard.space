import type { QueryResult } from './nostrTransport';
export function cancelledQuery(relays: readonly string[]): QueryResult {
  return { events: [], sources: {}, relays: Object.fromEntries(relays.map(url => [url, 'cancelled' as const])), complete: false };
}
