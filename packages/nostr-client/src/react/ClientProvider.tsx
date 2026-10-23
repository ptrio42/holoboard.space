import { createContext, useContext, useSyncExternalStore, type ComponentType, type ReactNode, type RefObject } from 'react';
import type { Capability, ContentPolicy, MediaPort } from '../core/ports';
import type { ComposerAttachment } from '../core/content/composerMedia';
import type { NoteQuoteReference } from '../core/content/noteAttachments';
import { createMediaPresentation } from './content/mediaPresentation';

export interface ProfileLinkProps { pubkey: string; hints?: string[]; className?: string; title?: string; children: ReactNode }
export interface QuoteProps { reference: NoteQuoteReference; adaptive?: boolean; initiallyExpanded?: boolean; initiallyExpandedTexts?: readonly string[]; parentMedia?: readonly string[] }
export interface LinkPreviewProps { text: string; url?: string | null; compact?: boolean }
export interface ClientServices {
  readonly policy: Pick<ContentPolicy, 'generation' | 'mediaAllowed' | 'onChange'>;
  readonly media: MediaPort;
  readonly connections: {
    getConnectedSigner(): { signEvent(template: import('nostr-tools').EventTemplate): Promise<import('nostr-tools').Event> } | null | undefined;
    getConnections(): { signerPubkey?: string | null; signerCanUpload: boolean };
    subscribeConnections(listener: () => void): () => void;
  };
  readonly profile: Capability<{
    useProfileValue(pubkey?: string, hints?: string[]): { displayName?: string; name?: string; nip05?: string } | undefined;
    Link: ComponentType<ProfileLinkProps>;
  }>;
  readonly quote: Capability<ComponentType<QuoteProps>>;
  readonly linkPreview: Capability<ComponentType<LinkPreviewProps>>;
  readonly navigation: {
    referenceUrl?(bech32: string): string;
    useMediaViewerHistory(onClose: () => void, opener: RefObject<HTMLElement | null>): () => void;
  };
  readonly presentation: ReturnType<typeof createMediaPresentation>;
}
const ClientContext = createContext<ClientServices | null>(null);
/** Services are instance-owned and stable for the mounted scope; changing identity remounts this provider. */
export function ClientProvider({ services, children }: { services: ClientServices; children: ReactNode }) {
  return <ClientContext value={services}><div className="nostr-client nostr-client-scope">{children}</div></ClientContext>;
}
export function useClient(): ClientServices {
  const value = useContext(ClientContext);
  if (!value) throw new Error('Note views require an explicit ClientProvider.');
  useSyncExternalStore(value.policy.onChange, () => value.policy.generation, () => value.policy.generation);
  return value;
}
export type { ComposerAttachment };
