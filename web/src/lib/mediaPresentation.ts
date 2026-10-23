import { createMediaPresentation } from '@ptrio42/nostr-client/react';
export const holoboardMediaPresentation = createMediaPresentation();
export const { knownMedia, rememberMedia } = holoboardMediaPresentation;
export { useMediaSelection } from '@ptrio42/nostr-client/react';
