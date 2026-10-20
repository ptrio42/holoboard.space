import { createNostrTransport } from '@ptrio42/nostr-client/core';
import { relayCandidates } from './relayPolicy';
export type { RelayOutcome, QueryResult, DeliveryOutcome } from '@ptrio42/nostr-client/core';
const transport = createNostrTransport({ candidates: relayCandidates, requireAuthorization: false });
export const { queryNostr, publishSignedEvent, monitorRelay } = transport;
