import { createMediaUploader } from '@ptrio42/nostr-client/core';
export { COMPOSER_FILE_LIMIT, COMPOSER_ATTACHMENT_LIMIT, mediaUrl, attachmentTags, readMediaJson } from '@ptrio42/nostr-client/core';
export type { ComposerAttachment, MediaServer } from '@ptrio42/nostr-client/core';
export const uploadMedia = createMediaUploader();
export const MEDIA_SERVERS = [
    { id: "primal", name: "Primal", protocol: "blossom", url: "https://blossom.primal.net" },
    { id: "build", name: "nostr.build", protocol: "blossom", url: "https://blossom.nostr.build" },
    { id: "check", name: "nostrcheck.me", protocol: "nip96", url: "https://nostrcheck.me", api: "https://cdn.nostrcheck.me" },
] as const;
