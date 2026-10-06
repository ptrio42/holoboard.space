# Holoboard web

The React frontend for [holoboard.space](https://holoboard.space), built with
Vite, Tailwind CSS and NDK. See the [project README](../README.md) for promotion
and billboard rules.

## Run locally

Run from `web/` with Node.js and npm installed:

```bash
npm install
npm run dev
```

Defaults connect to the live Holoboard relay. To use your own relay, copy
[.env.example](.env.example) to `.env.local` and edit its settings.

To use a local HTTP backend while keeping external Nostr relays, set
`VITE_API_URL=http://127.0.0.1:3334` and leave `VITE_RELAY_URL` and
`VITE_PUBLIC_RELAYS` pointing to the external relays. All board, preview,
promotion and author-support HTTP requests then use the local backend.
Leave `VITE_SATS_ENDPOINT` empty so the ledger follows that backend too.
Use a separate data file and a mock Lightning backend for local previews.
Mock invoices cannot be paid; the form reports test mode before sending any
wallet payment. To test real payments, configure the local backend's receiving
wallet using the [self-hosting guide](../docs/self-hosting.md#connect-a-wallet-for-real-payments).
The browser's NWC connection is a separate payer connection. Prepare a new
invoice after switching the backend; existing mock placeholders remain invalid.

## Check changes

```bash
npm run test
npm run lint
npm run build
```

The build checks TypeScript and creates the production website in `dist/`.
The development server does not check types. Production builds also generate
the web app manifest and service worker. Preview the production build to test
installation and offline startup, because the service worker is disabled in
development.

Browser payment tests use local HTTP and WebSocket mocks, generated test keys,
and no real wallets or funds. They cover desktop Chrome, Android-sized Chrome
and iPhone-sized WebKit:

```bash
npx playwright install chrome webkit
npm run test:e2e
```

Set `HOLOBOARD_TEST_PORT` to use a separate local server when another preview
is running. Browser tests override HTTP and relay settings with local mocks.
Payment tests block service workers so requests stay inside Playwright's API
mocks, as described in the [network testing documentation](https://playwright.dev/docs/network#missing-network-events-and-service-workers).
The PWA test enables workers and uses a real local mock API for those requests.

The PWA compatibility test is opt-in. Build a previous frontend from Git in a
temporary directory and build the current frontend, both with
`VITE_RELAY_URL=ws://127.0.0.1:3334` and
`VITE_PUBLIC_RELAYS=ws://127.0.0.1:3334`. Set `HOLOBOARD_LEGACY_DIST` to the
previous build's `dist` directory and run `npm run test:e2e -- tests/pwa.spec.ts`.
The test serves both builds and a mock API locally, checks old client requests,
worker activation, invoice restoration and API navigation outside the PWA shell.
Status requests must reach the mock API before and after the worker update,
including requests passed to `fetch` as URL objects, with their query and headers.
The restored anonymous invoice must remain usable through its wallet link,
clipboard action and a decoded QR payload.

These tests verify browser behavior and protocol exchanges. Before deployment,
also check a real NWC wallet and Amber on Android, including returning to the
website after approval. Device emulation does not verify app switching or OS
link handling. The Android app opens this same frontend through a TWA.

## Configuration

| Variable | Purpose |
| --- | --- |
| `VITE_RELAY_URL` | Board relay WebSocket URL. |
| `VITE_API_URL` | Optional HTTP API origin. Defaults to the WebSocket relay's host over HTTP(S). |
| `VITE_RELAY_PUBKEY` | Board identity, used for promotion mentions and zaps. |
| `VITE_PUBLIC_RELAYS` | Comma-separated relays for profiles, quoted notes, mentions and zaps. |
| `VITE_SATS_ENDPOINT` | Optional board API base URL, with a `/campaigns` subresource. Defaults to the HTTP API origin followed by `/api/board`. |

These settings are included at build time. Rebuild to change a deployed website.

For production updates, follow the [Fly and Cloudflare deployment
instructions](../relay/DEPLOYMENT.md#updating-the-existing-deployment).

## Where things live

- `src/config.ts`: relay URLs, identity and defaults.
- `src/pages/Billboard.tsx`: top 21 and the waiting room at `/waiting`, with Top, New and Hot views.
- `src/pages/Expired.tsx`: expired promotions.
- `src/components/BoardRow/`: ranked note cards.
- `src/components/BillboardScreen/`: shared billboard display for preview and feed.
- `src/components/PromoteModal/`: compact boosts, promotion editor panels,
  billboard preview, optional connections and resumable recipient payments.
- `src/components/Help/`: shared help for `/help` and contextual promotion panels.
- `src/lib/support.ts`: payment allocation, direct author invoices, optional NIP-07 zaps and proof verification.
- `src/lib/connections.ts`: optional NWC, extension and remote signer sessions.
- `src/lib/walletPayment.ts`: persisted attempts and safe payment recovery.
- `src/components/TextRenderer/`: note content, links and quote previews.
- `src/components/ui/` and `src/index.css`: shared controls and styles.

Board and waiting-room pages read signed original notes, global ranks, payment
weights and appearance together from the relay's
[campaign HTTP API](../relay/API.md#read-board-and-waiting-room-campaigns),
refreshing every 15 seconds. Each page contains up to 21 notes. Public relays
provide profiles, quoted notes and zap receipts. Ranking and payment decisions
belong to the relay.

The payment form separates first promotion from a boost: campaign settings and
active appearance stay fixed, while each payer chooses their own allocation.
New campaigns default to 80% visibility and 20% author support. Boosts use the
saved split; existing campaigns without one default to 100% visibility, with
author support available as an opt-in. Prepared invoices keep their allocations.
If a signed profile confirms no author payment address, new campaigns default
to visibility only. Temporary profile or provider failures preserve the split
and require an explicit visibility-only choice.
The author-support slider and switch live in **Adjust** beside the allocation.
The switch restores the last nonzero share when enabled again. Editor panels,
contextual help and connection panels keep the current draft in memory.
A connected wallet can prepare and pay both invoices after one explicit action;
**Prepare invoices only** preserves the manual path. Invoice status and payment
attempt recovery use the same protections in both paths. Global **Wallet** and
**Connect Nostr** controls are independent of promotion. The legacy
`#how-ranking-works` link opens contextual help; `/help` is the standalone guide.
[WebLN](https://www.webln.guide/building-lightning-apps/webln-reference/webln.sendpayment)
can pay the recipient invoices sequentially. The fallback exposes separate
Lightning links, copies and QR codes. An optional
[NIP-07 signer](https://github.com/nostr-protocol/nips/blob/master/07.md) signs a
public author zap. No signer is needed for ordinary author invoices. Partial
payments remain in session storage for the current tab; retry skips confirmed
parts. Manual author payment is explicitly unverified unless a receipt arrives.
If browser storage is blocked or full, payments stay in memory when reopening
the form. A visible notice explains that a refresh or closing the tab cannot
restore them. Invoice links, copying, QR and optional connections still work.
If preparing author support fails, the form offers visibility only and shows
the revised allocation before the payer requests a single visibility invoice.
It never redirects the author's share without the payer's choice.

## Optional wallet and signer connections

Invoice links, copying and QR codes stay available without connecting anything.
The payer's [NWC connection](https://github.com/nostr-protocol/nips/blob/master/47.md)
uses the [Alby SDK](https://github.com/getAlby/js-sdk) and is separate from the
relay's receiving wallet. Use an application-specific mainnet connection with
`get_info`, `pay_invoice` and preferably `lookup_invoice` permissions. The SDK
negotiates NIP-44, with NIP-04 compatibility for older wallets.

Wallet and remote signer credentials are stored in `sessionStorage`, never in
the page URL, `localStorage` or requests to the Holoboard backend. Connection inputs
are masked and cleared after submission. Disconnect deletes the local session;
revoke permissions in the wallet or signer to invalidate it there too. Tab
storage is accessible to scripts on this origin, so app-specific wallet spending
limits still matter. If storage is unavailable, connections work in memory.

[NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md) extensions
connect after a user gesture. [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md)
uses `nostr-tools` for Amber and other remote signers, through a `nostrconnect://`
link/QR or a pasted `bunker://` connection. Only `sign_event:9734` is requested.
Holoboard generates a separate client key and never asks for the user's Nostr
private key. Signatures must match both the requested event and connected
account. Remote sessions restore after a refresh; extensions reconnect through
the connection button. Signer authentication links must use HTTPS.
Public zap consent applies to the selected signer connection in the current
form. Changing or reconnecting the signer, reopening the form, or refreshing
ends that consent, even when the same account reconnects. Prepared invoices
remain available; replacements use ordinary author invoices after consent ends.

Every wallet attempt is stored before sending. A timeout or disconnect leaves
it uncertain. Retry checks the original NWC wallet first; missing lookup results
never imply failure. A reported payment is not sent again, even while the relay
or author proof verifier is unavailable. Without usable wallet lookup, the payer
must check their wallet and explicitly allow another attempt. WebLN has the
same protection after an uncertain result. Manual author confirmation remains
clearly unverified. Visibility status refreshes immediately when the tab resumes.
Invoice expiry is checked separately for each recipient and again before a wallet
payment is sent. An expired invoice does not block a valid invoice for the other
recipient or recovery of a previously submitted payment's proof. Unresolved
author attempts block invoice replacement until their outcome is checked.
An explicit failure confirmed by the original NWC wallet is saved as unpaid,
even after expiry, and enables replacement without another payment attempt.
Pending or unknown results, a different wallet, and submitted payments keep
their protection against replacement and another charge.

### Check on Android before release

Use a preview or deployment with the matching relay API. Choose an existing
note whose author has a working Lightning address and an amount accepted by
that wallet. Real payments cost sats, so use a small explicit test budget.

1. Without connecting anything, disable author support and prepare an invoice.
   Open it in a wallet, then return to Holoboard and check the visibility credit.
2. Set a custom author share, switch support off and on, and check that the
   selected share returns without changing the total.
3. Connect a limited NWC wallet. Confirm that connection alone pays nothing,
   then pay a split and check both recipients and the credited visibility amount.
4. Connect Amber using the link or QR, return to Holoboard, and enable a public
   author zap. Approve signing in Amber and check the author invoice appears.
5. Refresh with an unfinished payment. Check that the same invoices and
   connection return. If payment status is uncertain, check the wallet history;
   leave pending payments alone and retry only a confirmed failed attempt.
6. Disconnect wallet and signer. Check that ordinary invoice links, copying
   and QR codes still work. Repeat the app-switching checks in the Android TWA.

## Visual conventions

Use the pixel font for headings, controls and ranks; note bodies use a system
monospace font. Promotion amounts use a compact picker, while original-note text
and editor panel explanations use a readable body size. The modal scrolls its
body independently of the action footer, including on small phone screens.
Promotion actions and short labels share a 10px pixel style; panel headings use
12px. Note content, status messages and payment totals use 14px monospace text,
helper text uses 12px, and editable values use 16px. Connection controls use the
same action style in the app header and promotion panels.
Card frames show rank: gold, cyan and pink for the top three, then dim cyan.
Paid billboard text has its own selected color inside that frame.

[Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P), by CodeMan38,
is bundled as WOFF2 under the SIL Open Font License 1.1.
