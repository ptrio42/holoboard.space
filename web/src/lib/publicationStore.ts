import { IndexedPublicationStore as SharedStore } from '@ptrio42/nostr-client/core';
export type { PublicationStore } from '@ptrio42/nostr-client/core';
export class IndexedPublicationStore extends SharedStore {
  constructor() { super('holoboard-public-outbox-v1'); }
}
