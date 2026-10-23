import type { Event, EventTemplate, Filter } from 'nostr-tools';
import type { QueryResult } from '../../src/core/transport/nostrTransport';
import type { ComposerAttachment } from '../../src/core/content/composerMedia';
import type { PublicationStore } from '../../src/core/storage/publicationStore';
import type { Publisher } from '../../src/core/transport/nostrTransport';

import type { HostMedia, SimulatedMediaOptions } from './media';

export type ContentMode = 'community' | 'network';
export type HostView = 'content' | 'compose';
export interface AuthorSigner {
  generation: number;
  getPublicKey(): Promise<string>;
  signEvent(template: EventTemplate): Promise<Event>;
}
export interface HostIdentity {
  appId: 'holoboard-prototype' | 'nest-rel-prototype';
  principal: string;
  localRelay: string;
}
export interface ContentPolicy {
  mode: ContentMode;
  generation: number;
  relayAllowed(url: string): boolean;
  mediaAllowed(url: string): boolean;
  onChange(listener: () => void): () => void;
}
export interface HostPorts {
  identity: HostIdentity;
  policy: ContentPolicy;
  media: HostMedia;
  signer: AuthorSigner;
  query(filter: Filter, relays: string[], signal?: AbortSignal): Promise<QueryResult>;
  navigate(view: HostView): void;
  dispose(): void;
}
/** Task 6 binds these ports to PublicOutbox without changing per-relay outcomes. */
export interface PublicDeliveryPorts {
  store: PublicationStore;
  publish: Publisher;
}
export interface HostOptions {
  identity: HostIdentity;
  networkRelay?: string;
  mediaUrls?: readonly string[];
  media?: SimulatedMediaOptions;
  signer: AuthorSigner;
  query: HostPorts['query'];
  dispose?: () => void;
}
export interface HostDraft { text: string; attachments: ComposerAttachment[] }
export interface HostSnapshot { policyGeneration: number; view: HostView; draft: HostDraft; disposed: boolean }
