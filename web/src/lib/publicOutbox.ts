import { PublicOutbox as SharedOutbox } from '@ptrio42/nostr-client/core';
import type { PublicationStore } from './publicationStore';
import { IndexedPublicationStore } from './publicationStore';
import { publishSignedEvent } from './nostrTransport';
import { safeRelay } from './relayPolicy';
export type { PublicationRecord } from '@ptrio42/nostr-client/core';
const budget = { active: 0 };
export class PublicOutbox extends SharedOutbox {
  constructor(store: PublicationStore = new IndexedPublicationStore(), publish: typeof publishSignedEvent = publishSignedEvent) {
    super(store, publish, safeRelay, budget);
  }
}
export const publicOutbox = new PublicOutbox();
