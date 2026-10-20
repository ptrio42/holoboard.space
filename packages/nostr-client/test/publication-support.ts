import type { PublicationRecord } from '../src/core/storage/publicOutbox';
import type { PublicationStore } from '../src/core/storage/publicationStore';
export function memoryStore(): PublicationStore {
  let records: PublicationRecord[] = [];
  return { read: async () => structuredClone(records), change: async update => {
    records = structuredClone(update(structuredClone(records))); return structuredClone(records);
  } };
}
