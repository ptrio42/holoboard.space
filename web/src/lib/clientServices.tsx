import { ClientProvider, type ClientServices } from '@ptrio42/nostr-client/react';
import '@ptrio42/nostr-client/styles.css';
import type { ReactNode } from 'react';
import { getConnectedSigner, getConnections, subscribeConnections } from './connections';
import { MEDIA_SERVERS, mediaUrl, uploadMedia, attachmentTags } from './composerMedia';
import { gifSearchAvailable, searchComposerGifs } from './composerGifs';
import { useProfileValue } from '../hooks/useProfile';
import { ProfileLink } from '../components/ui/ProfileLink';
import { NoteQuote } from '../components/TextRenderer/NoteQuote';
import { NoteLinkPreview } from '../components/TextRenderer/NoteLinkPreview';
import { useMediaViewerHistory } from '../hooks/useMediaViewerHistory';
import { holoboardMediaPresentation } from './mediaPresentation';
import { safeMediaSource } from './noteMedia';

const services: ClientServices = {
  policy: { generation: 0, mediaAllowed: safeMediaSource, onChange: () => () => {} },
  connections: {
    getConnectedSigner,
    getConnections: () => { const value = getConnections(); return { signerPubkey: value.signerPubkey, signerCanUpload: value.signerCanUpload }; },
    subscribeConnections,
  },
  media: { available: true, servers: MEDIA_SERVERS, gifAttribution: { href: "https://nostr.build", label: "nostr.build" }, gifSearchLink: query => `https://gifs.nostr.build/search?q=${encodeURIComponent(query)}`, mediaUrl, uploadMedia, attachmentTags, gifSearchAvailable, searchComposerGifs },
  profile: { available: true, value: { useProfileValue, Link: ProfileLink } },
  quote: { available: true, value: NoteQuote },
  linkPreview: { available: true, value: NoteLinkPreview },
  navigation: { useMediaViewerHistory, referenceUrl: bech32 => `https://njump.me/${bech32}` },
  presentation: holoboardMediaPresentation,
};
/** Product-owned services preserve existing account, media and reading behavior. */
export function HoloboardClient({ children }: { children: ReactNode }) {
  return <ClientProvider services={services}>{children}</ClientProvider>;
}
