import NDK from "@nostr-dev-kit/ndk";

// NDK supplies event models. Connections, read discovery and
// cache lifetime belong to the bounded application read service.
export const ndk = new NDK({ explicitRelayUrls: [], enableOutboxModel: false });
