import { NostrCache as SharedCache } from '@ptrio42/nostr-client/core';
export { newerEvent, replaceableKey } from '@ptrio42/nostr-client/core';
export class NostrCache extends SharedCache {
  constructor(persistent = false) { super(persistent, persistent ? 'holoboard-nostr-read-v1' : undefined); }
}
export const nostrCache = new NostrCache(typeof window !== 'undefined');
