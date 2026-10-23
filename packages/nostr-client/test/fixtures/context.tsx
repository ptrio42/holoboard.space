import { ClientProvider, type ClientServices } from '../../src/react/ClientProvider';
import { createMediaPresentation } from '../../src/react/content/mediaPresentation';
import type { ClientHostServices } from './host';
import type { ReactNode } from 'react';
export function HostContext({ value: host, children }: { value: ClientHostServices; children: ReactNode }) {
  const unavailable = { available: false as const, reason: 'Unavailable in fixture.' };
  const services: ClientServices = {
    policy: host.policy, media: { ...host.media, servers: host.media.MEDIA_SERVERS },
    profile: unavailable, quote: unavailable, linkPreview: unavailable,
    connections: { getConnectedSigner: () => host.signer, getConnections: () => ({ signerPubkey: host.identity.principal, signerCanUpload: host.media.available }), subscribeConnections: host.subscribe },
    presentation: createMediaPresentation(), navigation: { useMediaViewerHistory: onClose => onClose },
  };
  return <ClientProvider services={services}>{children}</ClientProvider>;
}
