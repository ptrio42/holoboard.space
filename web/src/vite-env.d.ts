/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_RELAY_URL?: string;
    readonly VITE_RELAY_PUBKEY?: string;
    readonly VITE_PUBLIC_RELAYS?: string;
    readonly VITE_BOARD_LIMIT?: string;
    readonly VITE_SATS_ENDPOINT?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
