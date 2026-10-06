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
  `PromotionPayment.tsx` presents payment methods; `PaymentState.ts` defines the
  saved draft and restart eligibility.
- `src/components/Help/`: shared help for `/help` and contextual promotion panels.
- `src/lib/support.ts`: payment allocation, direct author invoices, optional NIP-07 zaps and proof verification.
- `src/lib/connections.ts`: optional NWC, extension and remote signer sessions.
- `src/lib/walletPayment.ts`: safe payment submission and recovery.
- `src/lib/walletAttempts.ts`: shared protection by invoice hash across wallet connections and payment views.
- `src/components/TextRenderer/`: note content, links and quote previews.
- `src/components/ui/` and `src/index.css`: shared controls and styles.

Board and waiting-room pages read signed original notes, global ranks, payment
weights and appearance together from the relay's
[campaign HTTP API](../relay/API.md#read-board-and-waiting-room-campaigns),
refreshing every 15 seconds. Each page contains up to 21 notes. Public relays
provide profiles, quoted notes and zap receipts. Ranking and payment decisions
belong to the relay.

Local copies of production storage must retain each note's payment history.
The public ledger provides totals and current weights, but it does not provide
the individual payment dates needed to reproduce decay. Treating the total as
one payment on the last-paid date can inflate a boosted note's local rank.

The payment form separates first promotion from a boost: campaign settings and
active appearance stay fixed, while each payer chooses their own allocation.
New campaigns default to 80% visibility and 20% author support. Boosts use the
saved split; existing campaigns without one default to 100% visibility, with
author support available as an opt-in. Prepared invoices keep their allocations.
If a signed profile confirms no author payment address, new campaigns default
to visibility only. Temporary profile or provider failures preserve the split
and require an explicit visibility-only choice.
The compact boost preview keeps reading actions beside the author, with at most
two text lines and one fixed-size image thumbnail. Nostr references remain
working links; expanding the note reveals its full text and images.
A two-color slider connects the Holoboard and author amounts and percentages.
Its handle divides the recipients; 100% Holoboard means visibility only.
**Use campaign split** restores the saved allocation.
Amount and Position use matching preset rows, ordered from lower to higher
cost, with Custom or ranking help in the fifth slot. Switching modes preserves
the selected amount. Target prices include the current author share and any
appearance fee; selecting one fixes the amount rather than tracking later
estimate changes. The full editor uses **Promotion**, **Billboard** and
**Payment options** tabs. Billboard appearance is available only for an inactive
note starting a promotion period. **Payment options** groups wallet connection
and optional notification DMs. Tabs and the payment action stay visible while
scrolling; switching tabs preserves the draft. Boosts keep the compact form.
The footer shows the complete
amount on the payment action; ranking and removal rules live in help. Contextual
help and settings panels keep the amount mode and current draft in memory.
Promote and Boost prepare invoices before opening **Promotion payment**.
**Wallet** and **Invoice / QR** are equal payment methods; NWC is first when
connected or restoring, otherwise the invoice method is first. WebLN remains
available in Wallet. Method and recipient selection survive help and connection
panels. Wallet payment needs an explicit action showing the amount that could
be charged; submitted attempts can only be checked. The invoice method shows
one recipient's QR immediately, with wallet link, copy and expandable invoice
text. Confirmation keeps the selected recipient until the payer chooses the next.
When all parts are complete, a result screen shows the credited visibility,
recipient amounts and current position, with Done and another-payment actions.
Manually reported author support stays explicitly unverified in that summary.
Wallet progress and pending verification use cyan status panels; an unresolved
result asks the payer to check their wallet after the request ends.

**Restart payment** checks backend settlement before clearing an explicitly
confirmed unpaid session and its last-payment pointer. It restores the saved
promotion draft, without requesting new invoices or clearing shared wallet
attempts and connections. Older sessions restore known amounts and allocation.
Paid or reported parts and unresolved wallet attempts block a full restart,
including after expiry. Expired recipient invoices can be replaced individually
when their own wallet attempt is resolved, preserving the other part.
Issued invoices remain payable; clearing local state
cannot cancel them. An unavailable backend does not block an explicitly
confirmed restart when no send attempt is recorded.
Invoice status and payment attempt recovery use the same protections in both
paths. Global **Wallet** and
**Connect Nostr** controls are independent of promotion. Inside the form, wallet
connection lives in **Payment options**, while signer controls appear with
the expandable **Public author zap** control and notification identity. The legacy
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
`get_info` and the permissions needed by the selected wallet features. Sending
requires `pay_invoice`, balance requires `get_balance`, receiving requires
`make_invoice`, and payment checks use `lookup_invoice`. Read-only and
receiving-only connections are accepted. The SDK
negotiates NIP-44, with NIP-04 compatibility for older wallets.

The wallet panel provides balance, Send, Receive, history and connection
permissions. Its history uses optional
[`list_transactions`](https://github.com/nostr-wallet-connect/nwc/blob/main/05.md)
with incoming/outgoing filters and pagination. An advertised `get_budget`
method shows the remaining connection budget separately from wallet balance.
Missing permissions never appear as zero balance or empty history. Failed
refreshes preserve previous data with an explicit stale-data message.

Send decodes mainnet BOLT11 invoices with
[`light-bolt11-decoder`](https://github.com/fiatjaf/light-bolt11-decoder), including
amountless invoices with an explicit amount. The wallet validates invoice
signatures before paying. A Lightning Address resolves directly through
[LUD-16](https://github.com/lnurl/luds/blob/luds/16.md) and
[LUD-06](https://github.com/lnurl/luds/blob/luds/06.md), without a proxy. Review
checks amount and metadata commitment before explicit payment confirmation;
address providers must support browser CORS requests. Camera and image QR
reading use `jsqr`, loaded on demand. Camera tracks stop when scanning ends or
the panel closes. Payment proofs are checked using Web Crypto SHA-256.

Invoice QR codes use uppercase alphanumeric encoding to reduce density.
Receive requests a one-hour invoice with amount, optional description, QR,
copy, share and wallet link actions. Optional
[NWC notifications](https://github.com/nostr-wallet-connect/nwc/blob/main/02.md)
refresh wallet data and confirm incoming invoices. While the panel is visible,
data also refreshes every 20 seconds and incoming status is checked every five
seconds when `lookup_invoice` is allowed. Returning to the page refreshes data.
Successful promotion payments refresh the same wallet balance and history.

The current send and latest receive invoice stay in tab storage under the NWC
connection identity. A shared tab-level registry protects each payment hash
across connections, promotion payments and the wallet panel. Balance and history
remain in memory. Closing or disconnecting does not erase uncertain payment
protection. Reconnect the original connection with `lookup_invoice` to check
its status, even if `pay_invoice` permission has been removed. A status check
in the wallet panel never sends another payment. A confirmed failure requires
a separate Send action to retry; missing status or an invalid proof keeps the
hash protected. New payment allows a different invoice while unresolved hashes
stay protected and available for review. Blocked storage preserves protection
in memory; the Send view explains that it cannot survive refresh.

The shared payment path verifies the returned preimage against the invoice hash
before storing a new submitted attempt. Saved proofs are verified again after
refresh; persisted confirmation flags are never trusted. The panel distinguishes
a wallet's report of sending from a verified payment. An older submitted attempt
with a missing or incorrect proof remains protected and can recover its proof
through lookup on the original connection, including a read-only connection.
Failed, pending or unknown lookup results never release a previously submitted
attempt or trigger another send.

Wallet and remote signer credentials are stored in `sessionStorage`, never in
the page URL, `localStorage` or requests to the Holoboard backend. Connection inputs
are masked and cleared after submission. Disconnect deletes those credentials;
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
it uncertain. Retry checks the original NWC connection first; missing lookup results
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

1. Without connecting anything, set the author share to 0% and prepare an invoice.
   Open it in a wallet, then return to Holoboard and check the visibility credit.
2. Set a custom author share and restore the campaign split. Switch between
   Amount and Position; check that toggling does not change the total and that
   target estimates account for the split.
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
