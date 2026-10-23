import { hostNamespace } from './policy';
import type { HostDraft, HostIdentity } from './ports';

/** Public draft data stays in this instance; no browser credential storage. */
export function createDraftStorage(identity: HostIdentity) {
  const namespace = hostNamespace(identity);
  let draft: HostDraft = { text: '', attachments: [] };
  return {
    namespace,
    read: () => structuredClone(draft),
    write: (next: HostDraft) => { draft = structuredClone(next); },
    clear: () => { draft = { text: '', attachments: [] }; },
  };
}
