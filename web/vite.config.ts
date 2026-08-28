import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
      react(),
      tailwindcss(),
  ],
  build: {
    rollupOptions: {
      treeshake: {
        /*
         * None of the nostr packages declare `sideEffects: false`, so rollup
         * keeps every module they import even when nothing references it. The
         * expensive case is @nostr-dev-kit/react, whose barrel statically pulls
         * in @nostr-dev-kit/wallet and @cashu/cashu-ts for hooks this app never
         * calls. Declaring those three trees side-effect free lets the unused
         * exports go, which is where roughly a third of the bundle went.
         */
        moduleSideEffects: (id) =>
            !/node_modules\/(@nostr-dev-kit\/(react|wallet|sync)|@cashu)\//.test(id),
      },
      output: {
        // Split the two heavy vendor trees out so a change to app code does
        // not force everyone to re-download React and NDK.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react'
          if (/node_modules\/(@nostr-dev-kit|nostr-tools|@noble|@scure|light-bolt11-decoder)\//.test(id))
            return 'nostr'
        },
      },
    },
  },
})
