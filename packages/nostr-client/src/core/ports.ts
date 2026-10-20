import type { Event, EventTemplate } from 'nostr-tools';
import type { ComposerAttachment, MediaServer } from './content/composerMedia';

export interface PublicReadIdentity { readonly appId: string; readonly principal?: string; readonly localRelay: string }
export interface ClientIdentity { readonly appId: string; readonly principal: string; readonly localRelay: string }
export interface AuthorSigner {
  readonly generation: number;
  onChange?(listener: () => void): () => void;
  getPublicKey(): Promise<string>;
  signEvent(template: EventTemplate): Promise<Event>;
}
/** The host owns admission and notifies before any previously allowed work continues. */
export interface ContentPolicy {
  readonly generation: number;
  configuredRelay(url: string): boolean;
  relayAllowed(url: string): boolean;
  mediaAllowed(url: string): boolean;
  onChange(listener: () => void): () => void;
}
export type Capability<T> = { readonly available: true; readonly value: T } | { readonly available: false; readonly reason: string };
export interface ComposerGif { url: string; preview: string; title: string }
export interface MediaPort {
  readonly available: boolean;
  readonly servers: readonly (MediaServer & { id: string })[];
  mediaUrl(url: string): string;
  uploadMedia(file: File, server: MediaServer, sign: (template: EventTemplate) => Promise<Event>, signal: AbortSignal, progress: (value: number) => void): Promise<ComposerAttachment>;
  attachmentTags(items: readonly ComposerAttachment[], text: string): string[][];
  readonly gifAttribution?: { href: string; label: string };
  gifSearchLink?(query: string): string;
  gifSearchAvailable(): boolean;
  searchComposerGifs(query: string, signal: AbortSignal): Promise<ComposerGif[]>;
}
export interface PublicationHost {
  readonly identity: ClientIdentity;
  readonly policy: ContentPolicy;
  readonly signer: AuthorSigner;
  readonly media: Pick<MediaPort, 'mediaUrl' | 'attachmentTags'>;
  snapshot(): { draft: { text: string; attachments: ComposerAttachment[] }; disposed: boolean };
  subscribe(listener: () => void): () => void;
}
