import { createNostrTransport } from '../../src/core/transport/nostrTransport';
import { relayCandidates, safeRelay } from '../../src/core/transport/relayUrl';
import { PublicOutbox as SharedOutbox } from '../../src/core/storage/publicOutbox';
import { IndexedPublicationStore as SharedStore } from '../../src/core/storage/publicationStore';
import { createMediaUploader } from '../../src/core/content/composerMedia';
export type { PublicationRecord } from '../../src/core/storage/publicOutbox';
export type { PublicationStore } from '../../src/core/storage/publicationStore';
export { attachmentTags, mediaUrl, readMediaJson } from '../../src/core/content/composerMedia';
export const uploadMedia = createMediaUploader();
const transport = createNostrTransport({ candidates: relayCandidates, requireAuthorization: false });
export const { publishSignedEvent, queryNostr } = transport;
export class IndexedPublicationStore extends SharedStore { constructor() { super('upstream-store-fixture'); } }
const budget = { active: 0 };
export class PublicOutbox extends SharedOutbox {
  constructor(...[store, publish]: ConstructorParameters<typeof SharedOutbox>) { super(store, publish, safeRelay, budget); }
}
