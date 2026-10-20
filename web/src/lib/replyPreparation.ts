import { prepareReply as sharedPrepareReply } from '@ptrio42/nostr-client/core';
import { relayCandidates } from './relayPolicy';
export { ReplyContextError } from '@ptrio42/nostr-client/core';
export type { PreparedReply } from '@ptrio42/nostr-client/core';
export const prepareReply = (options: Parameters<typeof sharedPrepareReply>[0]) => sharedPrepareReply({ ...options, candidates: relayCandidates });
