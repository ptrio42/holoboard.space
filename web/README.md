# Holoboard web

The React frontend for [holoboard.space](https://holoboard.space), built with
Vite, Tailwind CSS and NDK. See the [project README](../README.md) for promotion
and billboard rules.

## Run locally

Run from `web/` with Node.js and npm installed:

```bash
npm ci --legacy-peer-deps
npm run dev
```

The install hook installs the pinned shared client build tools from
`../packages/nostr-client`; dev, test and build compile that package first.
Keep both directories in the checkout. If lifecycle scripts are disabled, run
`npm ci --prefix ../packages/nostr-client --legacy-peer-deps --ignore-scripts`
explicitly before building. The shared editor, renderer and protocol helpers are
maintained in [the package](../packages/nostr-client/README.md); the web adapters
retain Holoboard's provider settings, navigation and global connection ownership.

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

## Page metadata

Profile titles use the author's display name, falling back to their name or a
short public key. Discussion titles use an excerpt of the focused note. Both
pages update descriptions and social metadata as public data loads, and restore
the board metadata when leaving the reader. These values are set in the browser;
the static HTML shell retains the default board metadata for crawlers that do
not execute JavaScript.

## Check changes

For agent-assisted verification, use the repository skill
[holoboard-verify-change](../.agents/skills/holoboard-verify-change/SKILL.md).
Its runner selects additive frontend, reader, payment, publication and backend
profiles, runs checks sequentially and saves logs and a JSON evidence report
outside the source checkout. It also checks that protected worktrees remain
unchanged. The default invocation prints a plan; add `--run` to execute it:

```bash
python3 ../.agents/skills/holoboard-verify-change/scripts/verify_change.py \
  --repo .. --profile readers --run
```

For release preparation or production build-configuration changes, add
`--pages-production` to include a build simulating Cloudflare Pages on `main`.
It uses local mock endpoints and checks the source revision and compiled Reply
chunk against the versioned feature profile, without deploying. Ordinary checks
omit this extra build. See the skill for its scope and limitations.

Use an explicit `--base <ref>` when verifying committed changes. Profile results
cover local automated checks; see the linked release gates for device, production
and interoperability checks. To check the runner itself, run its
`scripts/test_verify_change.py` with `python3 -B`.

```bash
npm run test
npm run lint
npm run build
```

The build checks TypeScript and creates the production website in `dist/`.

Run `node web/scripts/check-container-context.mjs` from the repository root to
check image COPY paths and install/build inputs without starting Docker. The
container smoke test runs this check before contacting the engine.
The development server does not check types. Production builds also generate
the web app manifest and service worker. Preview the production build to test
installation and offline startup, because the service worker is disabled in
development.

For worker lifecycle checks, await the explicit `statechange` to `activated`
inside `page.evaluate`, then assert the worker and page controller after reload.
Keep `waitForFunction` predicates synchronous; an asynchronous predicate can
resolve false without being polled again. Registration alone is not evidence
that the worker has finished activation.

Automatic worker updates preserve immutable modules needed by existing tabs,
including a QR generator that was not loaded before the update. Workbox normally
[removes obsolete precache entries during activation](https://developer.chrome.com/docs/workbox/modules/workbox-precaching).
The install hook copies only this application's hashed assets to a separate
archive. Its steady-state limits are 96 entries and 12 MiB, with a 24-hour
availability window; copying can temporarily use 24 MiB. These limits are
additional to the current build's precache. An oversized generation prevents
worker installation instead of activating an incomplete archive. API responses,
HTML shells, invoices and other worker scopes are excluded. Expired modules
require reloading the tab. Rolling back to an older worker also restores its
original asset policy; prefer a disabled-feature build containing this fix when
rollback must preserve lazy modules in still-open tabs.

Browser payment tests use local HTTP and WebSocket mocks, generated test keys,
and no real wallets or funds. They cover desktop Chrome, Android-sized Chrome
and iPhone-sized WebKit:

```bash
npx playwright install chrome webkit
npm run test:e2e
```

Give each simultaneous test run its own `HOLOBOARD_TEST_PORT`, including runs
in separate worktrees. The [Playwright configuration](playwright.config.ts)
reuses an existing local server on the selected port. Sharing a port can test
another checkout or lose the server when the run that started it finishes.
Use a separate `--output` directory for each run's Playwright-managed artifacts:

```bash
HOLOBOARD_TEST_PORT=4189 npm run test:e2e -- tests/wallet.spec.ts --output=/tmp/holoboard-e2e-4189
```

Browser tests override HTTP and relay settings with local mocks.
Payment tests block service workers so requests stay inside Playwright's API
mocks, as described in the [network testing documentation](https://playwright.dev/docs/network#missing-network-events-and-service-workers).
The PWA test enables workers and uses a real local mock API for those requests.

For the actual container build, nginx proxy, backend and restart check, run
`npm run test:release-containers` with a local Docker engine and Chrome available.
It builds both backend targets and the disabled-feature frontend, uses an
internal Docker network, a fresh identity and disposable volume, then removes
its containers, volume and image tags. It ignores checkout environment files.
Invoices use the mock backend and cannot be paid. Existing boards and wallets
are not used. See the [release checks](../relay/DEPLOYMENT.md#release-verification-and-rollback)
for the remaining device, interoperability and deployment gates.
For a feature release, add `-- --with-features` to build an additional enabled
frontend image. Container builds run sequentially. Use native tests and builds
for routine development; this smoke is for changes that need container evidence.

PWA compatibility tests are opt-in and use native mock-endpoint builds. The
supported historical invoice baseline is `f7d90b4`, not an arbitrary old commit.
The creation-recovery baseline `4329487` includes the approved durable-invoice
and wallet-attempt fixes, with the old category tabs. Build that revision twice:
creation/Nostr enabled for created-post recovery, and all features disabled for
reader/enabled compatibility rollback. These are distinct profiles.

Build each profile sequentially in its source checkout, using a fresh output
directory outside the checkout and no wallet or relay secrets. From `web/`, this
helper takes an output directory followed by creation, Nostr, discussions,
profiles and reply flag values:

```bash
build_pwa() {
  CF_PAGES=0 CF_PAGES_COMMIT_SHA="$(git rev-parse HEAD)" \
  VITE_API_URL=http://127.0.0.1:3334 VITE_RELAY_URL=ws://127.0.0.1:3334 \
  VITE_PUBLIC_RELAYS=ws://127.0.0.1:3334 \
  VITE_SATS_ENDPOINT=http://127.0.0.1:3334/api/board \
  VITE_RELAY_PUBKEY=1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f \
  VITE_ENABLE_POST_CREATION="$2" VITE_ENABLE_NOSTR_CONNECT="$3" \
  VITE_ENABLE_DISCUSSIONS="$4" VITE_ENABLE_PROFILES="$5" \
  VITE_ENABLE_REPLY_PUBLICATION="$6" npm run build -- --outDir "$1"
}
```

Create a fresh temporary root, for example `PWA_OUTPUT=$(mktemp -d)`, and retain
its absolute path across checkout shells. The profile table gives the arguments
to `build_pwa` and corresponding test inputs:

| Source | Output below `$PWA_OUTPUT` | Creation / Nostr / discussions / profiles / reply | Test input |
| --- | --- | --- | --- |
| `f7d90b4` | `legacy` | false / false / false / false / false | `HOLOBOARD_LEGACY_DIST` |
| `4329487` | `foundation-on` | true / true / false / false / false | `HOLOBOARD_ROLLBACK_DIST` for created-post tests |
| `4329487` | `compat-off` | false / false / false / false / false | `HOLOBOARD_ROLLBACK_DIST` for reader/enabled tests; `HOLOBOARD_COMPAT_ROLLBACK_DIST` overrides it for those tests when sharing a run with created-post recovery |
| Candidate | `creation-on` | true / true / false / false / false | `HOLOBOARD_CREATION_DIST` |
| Candidate | `creation-off` | false / true / false / false / false | `HOLOBOARD_CREATION_OFF_DIST`, `HOLOBOARD_CURRENT_DIST` |
| Candidate | `readers` | false / false / true / true / false | `HOLOBOARD_READER_DIST` |
| Candidate | `enabled` | false / true / true / true / true | `HOLOBOARD_ENABLED_DIST` |

For example, in the candidate checkout run
`build_pwa "$PWA_OUTPUT/creation-on" true true false false false`. Pin source
revisions in the verification report. All profiles explicitly use `CF_PAGES=0`
to avoid the Pages production override.

Run a targeted case from the candidate frontend, with one worker and a fresh
port/output directory. For the created-post cycle:

```bash
CI=1 CF_PAGES=0 HOLOBOARD_TEST_PORT=4292 \
VITE_API_URL=http://127.0.0.1:3334 VITE_RELAY_URL=ws://127.0.0.1:3334 \
VITE_PUBLIC_RELAYS=ws://127.0.0.1:3334 \
VITE_SATS_ENDPOINT=http://127.0.0.1:3334/api/board \
VITE_RELAY_PUBKEY=1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f \
VITE_ENABLE_POST_CREATION=false VITE_ENABLE_NOSTR_CONNECT=false \
VITE_ENABLE_DISCUSSIONS=false VITE_ENABLE_PROFILES=false \
VITE_ENABLE_REPLY_PUBLICATION=false \
HOLOBOARD_ROLLBACK_DIST="$PWA_OUTPUT/foundation-on" \
HOLOBOARD_CREATION_DIST="$PWA_OUTPUT/creation-on" \
HOLOBOARD_CREATION_OFF_DIST="$PWA_OUTPUT/creation-off" \
npx playwright test tests/pwa.spec.ts --grep 'created-post PWA' \
  --project=desktop --workers=1 --output="$PWA_OUTPUT/results-created"
```

Repeat the cycle with `--project=iphone`, a fresh port and fresh output directory
for WebKit coverage. It verifies actual worker activation, the same signed event,
invoice, hash, amounts and backend through update, rollback, real tab closure,
creation-off, re-enabling and settlement. Rendered QR payloads, clipboard values
and wallet links remain exact; storage audits check that the unpaid private post
stays outside public caches and guest keys stay outside persistent stores.

For historical invoices, set `HOLOBOARD_LEGACY_DIST` to `legacy` and
`HOLOBOARD_CURRENT_DIST` to `creation-off`, then select `--grep 'previous frontend'`.
Use the same command structure with a fresh port and output directory. Old
copies with unknown backend provenance remain read-only under **Older invoices**:
the candidate makes no guessed status lookup or durable import. The old document's
own polling is checked separately from candidate requests. This is browser-format
compatibility, not a server-data migration.

For reader rollback, set `HOLOBOARD_ROLLBACK_DIST` to `compat-off` and
`HOLOBOARD_READER_DIST` to `readers`, then select `--grep 'read-only PWA'`. This
checks worker activation, reader routes, the original anonymous invoice across
updates and code rollback, and cached application startup with both local HTTP
servers stopped. Status requests, including URL-object requests, must reach the
mock API with their query and headers before and after update. The outage does
not emulate a physical device's loss of connectivity. Playwright 1.63 WebKit's
`setOffline` rejects even literal worker responses; the server-unavailability
check covers this case instead. See the
[upstream issue](https://github.com/microsoft/playwright/issues/42775).
WebKit's native ledger-fetch transport message is accepted only alongside an
actual failed request started while the mock API was stopped.

For signer/reply compatibility, keep the `compat-off` rollback profile, set
`HOLOBOARD_ENABLED_DIST` to `enabled` and select `--grep 'enabled PWA'`. It preserves
the anonymous invoice and an unsigned reply draft through update, rollback and
re-enabling without connecting a signer, publishing or uploading. The verification
runner adds this case when a rollback baseline and the payments or publication
profile are selected. Created-post recovery requires `HOLOBOARD_ROLLBACK_DIST`
for the creation-enabled foundation, `HOLOBOARD_CREATION_DIST` and
`HOLOBOARD_CREATION_OFF_DIST`. When running reader/enabled cases alongside it,
set `HOLOBOARD_COMPAT_ROLLBACK_DIST` to `compat-off` so those cases use the
all-disabled baseline while created-post recovery keeps `foundation-on`.
Mock invoices cannot be paid; none of these cases establishes real wallet or
physical-device interoperability.

`HOLOBOARD_LIVE_READS=1 npm run test:reader-release` checks the public production
API contract, CORS and fresh note signatures with bounded GET requests. To also
exercise a production build with real public reads, serve it on loopback and
set `HOLOBOARD_PREVIEW_ORIGIN=http://127.0.0.1:4293`. Its compiled API and relay
origins must point to production. The smoke blocks HTTP writes, Nostr publication
and authentication frames, and checks board, discussion and profile reading.
For a compiled build with signer/reply flags enabled, set
`HOLOBOARD_REPLY_READ_SMOKE=1` to also open and preview an unsigned reply draft.
The same write restrictions remain in effect.
Set `HOLOBOARD_SMOKE_REPORT` to retain its JSON report outside the checkout.
No invoice is created and no payment or public publication is performed.
See the [read-only release contract](../docs/nostr.md#read-only-frontend-release)
for the visual integration checkpoint and remaining deployment checks.

These tests verify browser behavior and protocol exchanges. Before deployment,
also check a real NWC wallet on Android. For a signer release, check Amber and
returning to the website after approval. Device emulation does not verify app
switching or OS link handling. The Android app opens this frontend through a TWA.

Signer browser tests remain available in a separate run with the flag enabled:

```bash
VITE_ENABLE_NOSTR_CONNECT=true HOLOBOARD_TEST_PORT=4200 npm run test:e2e -- tests/payments.spec.ts --grep "signer|Amber|extension|public author zap|notification identity"
```

The opt-in Reply editor has a wide desktop dialog and a full-screen phone layout,
with its action footer remaining visible. Write and Preview share a tab-saved
draft. Emoji, GIF links and uploads insert into the text at the cursor. Select,
paste or drop files, choose Primal, nostr.build, nostrcheck.me or a custom Blossom
server, and upload explicitly. Files become public on the selected server before
the reply is published; no automatic payment or fallback upload occurs. Local
files are limited to 20 MiB each, eight attachments and 40 MiB selected in total.
Uploaded URLs and descriptions restore with the draft; unuploaded files stay
only until the editor closes. Signing and publishing remain separate steps.
Queued nostrcheck.me uploads wait for completed metadata through bounded,
authenticated status reads, without repeating the file transfer. Primal uses
its deployed legacy authorization encoding; other Blossom servers use BUD-11.
See the [reply and media contract](../docs/nostr.md#reply-editor) for permissions,
metadata, cancellation and provider compatibility limits.

GIF search uses gifs.nostr.build and works on localhost without registration.
Production search requires registering the site's origin, then setting
`VITE_ENABLE_GIF_SEARCH=true`; the flag defaults to false. Its registration fee
is separate from this implementation. Direct GIF links work without search.

## Configuration

| Variable | Purpose |
| --- | --- |
| `VITE_RELAY_URL` | Board relay WebSocket URL. |
| `VITE_API_URL` | Optional HTTP API origin. Defaults to the WebSocket relay's host over HTTP(S). |
| `VITE_RELAY_PUBKEY` | Board identity, used for promotion mentions and zaps. |
| `VITE_PUBLIC_RELAYS` | Comma-separated relays for profiles, quoted notes, mentions and zaps. |
| `VITE_ENABLE_NOSTR_CONNECT` | Enable signer UI and remote-session restoration in ordinary builds; defaults to `false`. |
| `VITE_ENABLE_DISCUSSIONS` | Enable discussion reading; defaults to `false`. |
| `VITE_ENABLE_PROFILES` | Enable author profile screens; defaults to `false`. |
| `VITE_ENABLE_REPLY_PUBLICATION` | Enable replies when discussions and signer support are also enabled; defaults to `false`. |
| `VITE_SATS_ENDPOINT` | Optional board API base URL, with a `/campaigns` subresource. Defaults to the HTTP API origin followed by `/api/board`. |

These settings are included at build time. Rebuild to change a deployed website.

Cloudflare Pages builds on `main` take the four discussion, profile, signer and
reply flags from [production-features.json](production-features.json). This
versioned release profile overrides those four build-environment values; local
builds and other branches retain their explicit environment flags and disabled
defaults. Review the release gates before changing the production profile.
Pages provides the build and branch markers described in its
[build configuration reference](https://developers.cloudflare.com/pages/configuration/build-configuration/).
Production HTML includes a `holoboard-revision` meta tag with the Pages commit
SHA, or the local Git HEAD for ordinary builds. Verify this tag after a push
before recording a release as deployed. It identifies source, not a passed gate.

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

Waiting-room updates poll `/api/board/waiting-updates` every 15 seconds and on
return to the visible page. Its exact count and note IDs cover all waiting-room
pages. The local visit checkpoint is scoped to `VITE_SATS_ENDPOINT`; the first
successful check establishes a baseline. A successful visible waiting-room load
acknowledges only the earlier of the campaign and update snapshot timestamps.
New marks remain throughout that visit. Failed requests do not advance the
checkpoint; blocked storage retains it in memory for the current page.

Each note previews its first ordinary link, including quoted notes and billboard
attachments. The compact promotion preview loads a card only when expanded.
Deploy the updated backend before the frontend to enable both new endpoints.
Older backends leave ordinary links usable and omit the waiting-room badge.
Metadata comes from the backend with no third-party preview provider. Thumbnails
load directly from their public source with no referrer; failed images leave a
text card. Requests are lazy and shared by URL, with bounded browser caching.

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
cost, with Custom in the fifth slot in both modes and ranking explanations in
Help. A shared row keeps the picker height stable. Switching modes preserves
the selected amount, allocation and open Custom field. Target prices include
the current author share and any appearance fee; selecting one fixes the amount rather than tracking later
estimate changes. The full **Add to board** editor follows **Post**, **Budget**
and **Payment**. The general action opens blank Post with an explicit unfinished
payment list; a known inactive original can enter Budget directly. Post reviews
an original or, when creation is enabled, prepares a new post or comment.
Budget keeps amount, allocation, complete total and **Continue to payment**
together. Optional **Billboard** and **Notifications** panels are available before
invoice preparation. Appearance applies only when starting a promotion period,
including revival after expiry. Billboard can be opened before loading a note
and explains its note and campaign requirements. The total and invoice action
stay visible inside optional panels. Stage navigation preserves the composer,
its guest key and current choices. Boost on an active note keeps its compact
form without task progress; pasting an active original into general Post can
still review it or add a comment when creation is enabled.
The footer shows the complete
amount on the payment action; ranking and removal rules live in help. Contextual
help and settings panels keep the amount mode and current draft in memory.
**Continue to payment** and **Boost** prepare invoices before opening payment.
Prepared payments freeze the signed post, recipients, total and saved appearance
fee breakdown; returning to edit does not change an issued invoice. Older invoices
without a saved fee breakdown retain neutral amount labels rather than guessed fees.
**Wallet** and **Invoice / QR** are equal payment methods; NWC is first when
connected or restoring, otherwise the invoice method is first. WebLN remains
available in Wallet. Method and recipient selection survive help and connection
panels. Wallet payment needs an explicit action showing the amount that could
be charged; submitted attempts can only be checked. The invoice method shows
one recipient's QR immediately, with wallet link, copy and expandable invoice
text. Selecting an invoice reveals its full-size QR within the scrolling body
above the fixed payment controls. Confirmation keeps the selected recipient
until the payer chooses the next.
When all parts are complete, a result screen shows the credited visibility,
recipient amounts and current position, with Done and another-payment actions.
Manually reported author support stays explicitly unverified in that summary.
Wallet progress and pending verification use a compact cyan indicator with
screen-reader status text. An unresolved result asks the payer to check their
wallet after the request ends. Split QR payments show separate numbered invoices;
ordinary author invoices explain that external-wallet payments cannot be
confirmed here automatically and manual reports remain unverified.

**Restart payment** checks backend settlement before clearing an explicitly
confirmed unpaid session and its last-payment pointer. It restores the saved
promotion draft, without requesting new invoices or clearing shared wallet
attempts and connections. Older sessions restore known amounts and allocation.
Paid or reported parts and unresolved wallet attempts block deletion of the
session, including after expiry. Restart holds both recipient hash locks until
the invoice, pointer and authoritative shared-attempt check finish in one
transaction. Delayed refresh notifications cannot hide another tab's attempt.
Missing storage or coordination keeps the invoices available and blocks clearing
the session. Failed deletion is never retried outside its original locks.
**Back to promotion** returns to the editor
and keeps the session under **Previous payment for this note**. It can interrupt
an active wallet request without sending the next part or losing its proof.
Preparing another payment archives the previous invoices under their note and
visibility payment hash. Late wallet replies update only their own record and
never change the current note or last-payment pointer. Author status and proofs
also require the original author invoice hash; an old snapshot cannot replace a
newer author invoice. Recipient replacement uses a separate transaction that
rechecks expiry, the expected hashes and unresolved attempts while preserving
the other recipient's current confirmation. Completed sessions, including
manually reported author support, move to the invoice archive when starting
another payment. Resume
restores the original invoices and reconciles their remaining parts.
The general promotion action opens a blank editor with an explicit unfinished
payment list; a specific note restores only its own session. Returning to editing
survives reopening. Expired, unattempted sessions reopen in the editor while
retaining their invoices for review. Changing notes clears amount, split,
appearance, notifications, public-zap consent and stale status messages.
Unfinished invoices survive closing the tab in the same browser profile and app
origin. The editor waits for private IndexedDB storage before listing saved
payments. While a payment resumes, its source and payment selection stay locked
until saving finishes. Closing the editor cancels the pending view change while
keeping its invoices. Recovery requires explicit selection and preserves original invoices,
hashes, signed post snapshots and the configured API URL and relay identity.
This database is separate from public read caches and the publication outbox;
it contains no guest author keys or wallet/signer credentials. Invoice and
metadata changes commit together, including hash-scoped archived updates.
Durability follows the transaction's completion, as defined by the
[IndexedDB transaction lifecycle](https://w3c.github.io/IndexedDB/#transaction-lifecycle).
Failed writes keep records in memory with a visible limited-lifetime notice.
They are retried on the next change without evicting unresolved or expired invoices.

Old tab-storage records without matching original backend metadata are never
assigned to the currently configured backend or imported into durable recovery.
Their originals stay untouched. **Older invoices** exposes their original amounts,
Lightning links, copies and QR codes without signing, publication, connections,
new invoices or backend status requests. Compatible records with explicit matching
backend metadata can be imported without replacing durable records or deleting
the tab-storage originals. This is browser-format compatibility, not a server-data
migration. Recovery requires the same site, browser profile and device; clearing
site data removes it. Unsigned draft autosave, guest-key recovery and cross-device recovery
are separate features and are not supplied by invoice snapshots.
Expired recipient invoices can be replaced individually
when their own wallet attempt is resolved, preserving the other part.
Issued invoices remain payable; clearing local state
cannot cancel them. An unavailable backend does not block an explicitly
confirmed restart when no send attempt is recorded.
Invoice status and payment attempt recovery use the same protections in both
paths. Global **Wallet** is independent of promotion. Inside Payment, optional
wallet connection sits beside the **Wallet** method. Production enables Nostr
signer controls and remote-session restoration through the versioned release profile;
confirmation DMs also accept a manually entered npub. The legacy
`#how-ranking-works` link opens contextual help; `/help` is the standalone guide.
[WebLN](https://www.webln.guide/building-lightning-apps/webln-reference/webln.sendpayment)
can pay the recipient invoices sequentially. The fallback exposes separate
Lightning links, copies and QR codes. Without a signer, author support uses
ordinary invoices. Partial payments remain in private recovery storage; retry
skips confirmed parts. Manual author payment is explicitly unverified unless a
receipt arrives.
If private storage is blocked or full, payments stay in memory when reopening
the form. A visible notice explains that a refresh or closing the tab cannot
restore them. Invoice links, copying, QR and optional connections still work.
If preparing author support fails, the form offers visibility only and shows
the revised allocation before the payer requests a single visibility invoice.
It never redirects the author's share without the payer's choice.

## Optional wallet and signer connections

`VITE_ENABLE_NOSTR_CONNECT` defaults to `false` for ordinary builds. Production
Pages builds on `main` enable it through `production-features.json`, alongside
discussions, profiles and replies. Other builds can set the flags explicitly.
When signer support is disabled, entry points, public-zap creation and remote
restoration are hidden. Existing invoices and manual npub notifications work
with either setting.

The header's Sign in offers a browser extension or Amber / remote signer, with
manual bunker-link setup in a disclosure. Missing extension support is explicit.
During remote pairing, opening the signer is the primary action; copying and
cancelling stay above the optional QR code. Successful header sign-in closes
the panel and returns focus to the connected avatar. Pending approval and errors
stay visible. Connected accounts use only the avatar at every screen width;
the account name and connection settings remain in its menu.
Account sign-in, reply signing and public-zap setup share the same connection
session, while their explanations follow the action the user is taking.

Invoice links, copying and QR codes stay available without connecting anything.
The wallet connection form accepts a masked NWC link through its Connect wallet
action or Enter. Setup help expands on demand; connecting never sends a payment.
Successful header wallet connection closes setup and returns focus to the wallet
icon. Opening an already connected wallet keeps its panel available.
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
checks the exact amount, network and expiry before explicit payment confirmation.
Ordinary LNURL-pay invoices may use a plain description or a provider-defined
description hash. Address providers must support browser CORS requests. Camera
and image QR reading use `jsqr`, loaded on demand. Camera tracks stop when scanning ends or
the panel closes. Payment proofs are checked using Web Crypto SHA-256.

Invoice QR codes use uppercase alphanumeric encoding to reduce density. The
shared QR renderer adds the pink Holoboard H near the center only after an
H-correction candidate decodes to the exact payload at the measured display size
and, for larger codes, at 220px. Container resizing regenerates the symbol for
its available width instead of shrinking an already validated image. Validation also covers the device pixel scale
(up to 3x). It preserves four quiet
modules and leaves tracking and alignment patterns clear. The candidate uses
a conservative two-CSS-pixel module budget at no more than 220px, including
larger signer codes. Dense codes, encoding overflow, unavailable branding or
failed validation retain the unbranded M-correction SVG renderer. Branded codes
display the validated local PNG raster, avoiding differences between canvas
validation and WebKit's SVG edges. Optional branding
has a three-second deadline so stalled assets cannot block invoices. The generator
and decoder load on demand; validation keeps invoices and connection tokens in
the browser. Logo overlays consume the QR's
[error-correction capacity](https://www.qrcode.com/en/about/error_correction.html).
Browser decoding does not replace physical wallet and signer scans.
`tests/qrCodes.spec.ts` covers both display sizes, payload replacement and stalled
mark recovery. For dense unbranded grids, jsQR may require module-aligned
resampling of fractional-pixel screenshots; keep the rendered image and use an
independent decoder when investigating a failed round trip.
Receive requests a one-hour invoice with amount, optional description, QR,
copy, share and wallet link actions. Optional
[NWC notifications](https://github.com/nostr-wallet-connect/nwc/blob/main/02.md)
refresh wallet data and confirm incoming invoices. While the panel is visible,
data also refreshes every 20 seconds and incoming status is checked every five
seconds when `lookup_invoice` is allowed. Returning to the page refreshes data.
Successful promotion payments refresh the same wallet balance and history.

The current send and latest receive invoice stay in tab storage under the NWC
connection identity. Shared wallet attempts live in the private IndexedDB payment
database and protect each invoice hash across connections, tabs, promotion
payments and the wallet panel, independently of the invoice backend. Balance and
history remain in memory. Closing or disconnecting does not erase uncertain payment
protection. Reconnect the original connection with `lookup_invoice` to check
its status, even if `pay_invoice` permission has been removed. A status check
in the wallet panel never sends another payment. A confirmed failure requires
a separate Send action to retry; missing status or an invalid proof keeps the
hash protected. New payment allows a different invoice while unresolved hashes
stay protected and available for review. Hash-scoped
[Web Locks](https://www.w3.org/TR/web-locks/#dom-lockoptions-ifavailable)
use `ifAvailable`, so a competing action fails immediately instead of waiting to
send after navigation. Each action rereads the durable attempt while holding the
lock. Older known snapshot revisions cannot undo a committed resolution; unknown
revisions and verified preimages remain protective. Passive invoice reads do not
import attempt state; explicit wallet actions reconcile their original caller
snapshot with durable state. An action that loses the lock still commits stronger
caller evidence before reporting that another action is in progress. These
imports can only add protection. Lookup resolutions apply to the exact revision
that was checked; new unknown uncertainty or proof invalidates an old resolution.
Sending starts only after its uncertain attempt transaction commits and the
caller save finishes. A final durable reconciliation and synchronous guard stop
the send if newer evidence arrived during either write. Expiry is checked again after pending
writes, immediately before sending. Submitted proof writes are also awaited. The transaction requests
[`strict` durability](https://www.w3.org/TR/IndexedDB/#dom-idbtransactionoptions-durability)
and resolves only on completion. Browser closure releases the lock, while a
committed uncertain attempt retains the original wallet identity and hash.
Missing responses stay uncertain until original-wallet lookup or explicit failure
acknowledgement resolves them. These guarantees cover browser closure, not every
operating-system or storage-device failure.

Missing Web Locks, failed writes and malformed or unknown stored attempts block
wallet sends. Original-wallet lookup can still run without authorizing a send;
unavailable storage cannot persist its result or release uncertainty. Invoice
links, copying and QR remain available. Broadcast messages contain no payment
data and only request a fresh database read. Legacy tab records retain conservative
hash barriers without assigning their invoices to an API backend. Valid old
barriers are copied into private storage without erasing their originals.

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

## Add to board

The main action and editor are named **Add to board**, regardless of the creation
flag. `VITE_ENABLE_POST_CREATION=true` enables a shared text/link field in that
editor. A standalone `note1`, `nevent1`, `nostr:` URI, raw 64-character
ID or exact `njump.me` note route selects the original. **Add a comment** switches
to a new quote; removing the comment keeps that choice until **Use original**.
Ordinary links, descriptions and text containing Nostr references create new
posts. Arbitrary URLs containing a note identifier remain ordinary links.

While writing, the editor loads the first ordinary link preview and first quote.
A missing web preview leaves the post usable. Quoted sources must be verified
before signing and invoicing. The signing payload canonicalizes Nostr references
and includes distinct `q` tags; editor text and cursor remain unchanged. Payments,
ranking, author support and discussion belong to the new quoted post, not its
source. Billboard appearance uses the paid event's content.

Signed-out authors create a guest post with a fresh in-memory key. **Save author
key** optionally exports `nsec`; an unsaved key cannot be recovered after refresh,
closing the editor or reviewing changed content. Signed invoice snapshots remain
recoverable without it.
Logged-in authors can explicitly choose **Post anonymously**. Guest posts label
their own author **Anonymous** using signed NIP-32 tags in
`space.holoboard.attribution`; public keys remain available in details. This
self-report does not prove key freshness or anonymity from the operator or
payment providers. Guest-authored posts allocate the full promotion budget to
visibility and show a visibility-only summary in Budget. Optional Billboard
appearance adds a separate fee with no ranking weight. These posts have no
account-bound notifications or public zap consent. A payer without an account
promoting someone else's signed note can still split author support and enter a
manual npub for notifications.

**Review & continue** signs a new post exactly as reviewed before opening Budget.
It does not publish.
Reviewing unchanged text, interpretation and author reuses the same signed event
and guest key. The composer stays mounted while payment and contextual panels
are shown; author details and optional key export remain owned by that composer.
The invoice stores that signed snapshot separately from the browser public
outbox. Changing text prepares a different event while earlier invoices retain
their own content, ID and payment attempts. Settlement commits the board entry
and a durable root publication job on the backend. External relay delivery has
its own status; it can continue after the payment result or browser closure.

Existing Nostr accounts connect through browser extensions, Amber or remote
signers when `VITE_ENABLE_NOSTR_CONNECT=true`. Sign-in preserves the live editor
and payment choices. Guest posts work without a signer or account service.
Email/password accounts are deferred separately. The current Pages production
configuration explicitly defines post creation as disabled, regardless of an
environment-only `VITE_ENABLE_POST_CREATION=true` change. Activation requires a
reviewed build-configuration change as well as matching backend support. With
creation off, existing-note promotion and recovery of issued new-post invoices
remain available. Backend `ENABLE_POST_CREATION=false` blocks new admission while
preserving settlement, retries and recovery for already issued invoices.

For Cloudflare Pages builds on `main`, `vite.config.ts` explicitly sets
`VITE_ENABLE_POST_CREATION=false`. An environment variable alone cannot enable
creation in this profile; activation needs a reviewed change to the versioned
build configuration as well as a compatible backend. The Add to board label
remains independent of creation availability.

Browser acceptance uses local extension signers, invoices and relays:

```bash
VITE_ENABLE_POST_CREATION=true VITE_ENABLE_NOSTR_CONNECT=true CI=1 \
npm run test:e2e -- tests/boardCreation.spec.ts --workers=1
```

## Visual conventions

The repository's [holoboard-ui skill](../.agents/skills/holoboard-ui/SKILL.md)
provides a repeatable workflow for reviewing, comparing and implementing visual
changes across Holoboard screens. Invoke it as `$holoboard-ui` in a skill-aware
agent, or read its instructions directly.

Use the pink pixel H from `src/assets/holoboard-mark.svg` as the shared mark.
It follows the H in the HOLOBOARD wordmark; keep the full wordmark on desktop.
The mobile header and QR renderer use the vector directly. Generate the favicon
and installed-app icons from the same source with
`python3 -B web/scripts/brand-assets.py` from the repository root (requires
Pillow); add `--android` to refresh native launcher, splash and store assets.
Keep maskable artwork inside the
[manifest safe circle](https://www.w3.org/TR/appmanifest/#icon-masks).
Icon regeneration does not build
or publish an Android package.

Use the pixel font for headings, controls and ranks; note bodies use a system
monospace font. Promotion amounts use a compact picker, while original-note text
and editor panel explanations use a readable body size. The modal scrolls its
body independently of the action footer, including on small phone screens.
Promotion actions and short labels share a 10px pixel style; panel headings use
12px. Board notes and focused notes use a 16px monospace base size; compact
discussion comments use the same 16px body size. Promotion
previews and payment totals use 14px, helper text uses 12px, and editable values
use 16px. Connection controls use the same action style in the app header and
promotion panels.
Card frames show rank: gold, cyan and pink for the top three, then dim cyan.
Paid billboard text has its own selected color inside that frame.

Compare content layouts on the same frozen public notes at phone and desktop
widths, keeping typography and footer controls consistent. Include text-only
notes, portrait screenshots, photographs, galleries, destination links, video,
quoted context and active billboards with their attachments. Assess what is visible
before expansion, image legibility,
available reading and playback actions, and card height across a whole board.
Extra expansion clicks can reflect hidden content, so they do not establish a more
effective promotion by themselves. Preserve the original signed content.

Keep public event IDs, frozen fixtures and viewport sizes with the review setup
so a later comparison can reproduce the same content. Use mock layouts to choose
a direction, then repeat the comparison with the implemented components. Include
missing images, partial data, loading and empty states. Check keyboard focus and
the first visible frame when entering a discussion or returning to the board.

On phones, keep the author on its own footer line, followed by one action row:
ranking weight and Boost on the left, discussion, reply and note options on the
right. Preserve 44px hit areas and exact amounts in the ranking details. Desktop
cards keep the author and controls together when their container is wide enough.
Continuous reading stabilization preserves a visible content block when earlier
media or previews arrive, separately from navigation restoration. Intentional
layout changes and modal scroll ownership take precedence; see the
[reading contract](../docs/nostr.md#discussion-screen).

For inline expansion, place `more` at the text cutoff and `less` immediately
after the expanded text, before media and footer controls. Expand quoted text
independently. Keep existing media in place and omit expansion controls when
the complete text is already visible.
Read-cache snapshots copy tag arrays. Derive text and attachments from their
values so incremental relay results do not remeasure unchanged visible notes.

Ordinary board cards place text beside media on wide screens and stack them on
phones. Column proportions follow the first media frame and the amount of text,
while reserving a readable text column. Gallery selection does not change those
proportions. Long ordinary URL labels use a bounded single line, with a shorter
phone footprint; their complete text, destination and hover title remain intact. Keep the rank on a compact line above the content, with text and media
starting below it. Short openings use larger type; all text-only notes use the
full available width, including their expanded text.
Long board text previews use up to six lines on desktop; expanding shows the
complete original text without changing its attachments.
Complete short text can sit centrally beside taller media while staying aligned
to the left. Billboards use the same vertical placement. Long text remains at the
top. Quotes follow the original note's text, media and destination preview at the
full card width. Each quote lays out its own text and media independently, so a
tall quote does not stretch the original media column. Quote text uses 14px type,
secondary to the 16px ordinary note body, with independent expansion. Skip quoted
media whose exact URL is already displayed by the original note; keep that source
accessible through its gallery and the quote's external reading link.
[NIP-23 articles](https://github.com/nostr-protocol/nips/blob/master/23.md) use
Markdown previews parsed by the pinned `marked` lexer. Render basic formatting,
lists, code and link labels as React nodes, never generated HTML. Only HTTP(S)
destinations without credentials can become article links or media. HTML stays
inert text, and fenced or inline code cannot create media or destination previews.
Ordinary kind-1 quotes retain their literal text. Article previews use the same
local expansion, shared galleries, link previews and bounded Nostr reads.
Link preview titles and descriptions each use at most two lines. Inside quotes,
use a horizontal preview with a 64px thumbnail and one line each for the hostname,
title and description. Keep unloaded quote status beside its external reading
action; timeout retains an explicit retry. Hostname labels use 10px pixel type.
Avoid display utilities that override the line clamp.
When a note contains both media and a destination link, compare the complete
card height with the preview under the text and under the media. Use the shorter
composition, including cases where text and its preview extend below a short
landscape image. Placement responds to column width, loaded content and text
expansion. Inert thumbnail-free measurements compare both preview shapes without
duplicating requests or replacing the live card or media. Phones preserve the
document order: text, media, then the link preview. Failed link-only previews
release their empty desktop column.
Note galleries show one complete image or video in source order, with a bounded
thumbnail strip and explicit unavailable items. The first source determines a
stable frame, capped at `min(55svh, 420px)` for a single item and
`min(60svh, 460px)` for multiple items (`min(40svh, 280px)` in quotes).
Arrows and the counter sit over the main frame; the bounded thumbnail strip
stays below it. Keep overlay controls clear of native video playback controls.
Multi-item galleries reserve at least a square before applying that cap, so an
opening panorama cannot shrink later portraits. Unknown single sources start at
4:3 until measured; unknown multi-item galleries start square. Selection changes
do not resize the frame. Preserve exact URLs, including signatures and
fragments, when matching signed
[NIP-92 metadata](https://github.com/nostr-protocol/nips/blob/master/92.md).
Validated dimensions, alternative text, MIME and video posters may supplement
the source. Intrinsic dimensions replace inaccurate hints once the file loads.
Extensionless media needs matching MIME metadata.

The full-screen phone viewer uses pinned
[Yet Another React Lightbox](https://yet-another-react-lightbox.com/)
with Inline and Zoom inside the shared Modal. It owns swipe, pinch and double-tap
zoom; the shared shell owns focus, Escape and scroll locking. Only the current
slide is admitted, with no video elements in thumbnails. Back closes the viewer
before leaving the reader. Holoboard navigation replaces an open viewer entry;
closing on a route change never triggers a second history traversal. Route
transitions must use `navigateReading` to consume this temporary entry; a foreign
raw `pushState` cannot remove its predecessor from browser history. Cancel a
pending lazy viewer when its originating route changes.

Videos keep native controls and need explicit playback. Show the Play icon over
the supplied poster or a paused native video frame. Without a usable poster,
a visible player seeks briefly into the clip to reveal its first frame, while
preserving a saved playback position. Metadata loading begins when a player
becomes visible. Native
[`preload="metadata"`](https://html.spec.whatwg.org/multipage/media.html#attr-media-preload)
is a browser hint; decoding a frame can require additional media data. Do not add
background thumbnail players or extract frame images into a canvas cache. Pause when
hidden, outside the viewport, on navigation, or when another player starts.
Opening any viewer pauses registered players. A video viewer transfers the saved
playback position without autoplay, including on return to a retained board.
Media presentation stays in memory: at most 512 exact sources for 30 minutes,
failures for 60 seconds, and 128 gallery selections for 30 minutes. It stores no
identity or payment data. Retry and original-source actions remain available.
Physical phone playback and pinch behavior still need device testing; WebKit
emulation is separate evidence. Billboard animations occupy the text area in
the same adaptive composition and share its media galleries. They keep a separate
original-text disclosure in note options. Mentions retain nprofile relay hints
inside animations as well as ordinary text. Direct discussion focuses and profile
promotions reuse the adaptive note card, including local text expansion, bounded
quote and destination previews, rank, current weight, total paid and Boost.
Profile cards and direct focuses show the original signed note. Board-origin
focuses preserve the source card's geometry, campaign appearance and expansion.
Comments keep a lighter row with 16px text. Author and exact parent navigation
share a header; nested parent excerpts stay on one secondary line. Branch
disclosures use a stepped chevron and count beside the footer actions.
Earlier context starts collapsed, remembers explicit expansion and opens
automatically when navigating to an exact ancestor. Reply actions use the shared speech bubble,
and comment timestamps open their thread. The Replies count is compact; a short
coverage status keeps read limits and source explanations behind Source details.
Phone branch steps are 8px, capped at
four visible levels, and their bodies use the row's full available width. Exact
parent links remain 44px targets. A visible unresolved-context disclosure groups
specific relationship warnings without changing or inferring graph relations.

Primary section navigation contains TOP 21 and Waiting room. Expired notes remain
available in the footer beside Help and GitHub, with a current-page indication
inside the archive.

The board header reads as a neon sign above the feed: the pink wordmark has a
soft glow, and a quiet cyan rail with a stepped end joins the navigation. The
current section marks its part of the rail in gold. From 1024px, brand, sections
and actions share one row. Smaller screens use two rows; below 768px, the H,
wallet and account icons accompany a compact Add button. Its accessible name
remains Add to board, including when post creation is disabled. The full action
label returns from 768px. The header scrolls
with the page and shares the feed's width.

Keep the main action as the header's only strongly framed control, with 8px of
clearance above the desktop rail. Waiting-room sorting uses quiet Rank, New and
Hot buttons from 768px, without a Sort label. A separate stepped question-mark
icon opens sorting help without looking like another selected mode. Phones show
the current choice in a menu beside the sections. Both presentations retain the same sort
and URL, with ranking help available in context. Keep header targets at least
44px, pixel labels at least 10px, and footer links compact enough for a 320px
viewport. These layout rules do not change the note cards or payment flow.
Honor safe-area insets around the board shell. Touch header controls use a
pressed state without the desktop hover lift, while keeping browser zoom and
system navigation gestures available.

Board section links navigate inside the client while keeping real URLs and
modified-click behavior. TOP 21 and the current waiting-room view retain public
list data, loaded pages and expanded text for this app session, then refresh on
return. History restores the visible note and scroll position without requiring
an account. The waiting-room link retains its last sort; reloading restores the
sort from the URL and starts with the first page. Payment records keep their
existing storage and explicit resume flow.

Opt-in profiles place an author column beside notes on desktop and a compact
identity section above notes on phones. Optional banners remain bounded within
that section, NIP-05 appears near the name, and a separately labelled Lightning
address has a copy action. Missing fields leave no reserved space. A NIP-05
check confirms the domain-to-key mapping; checking, unavailable and key-mismatch
states remain distinct, with a compact retry action beside unavailable checks.
Full keys, public-key copying, external profile links and source diagnostics
live in Profile details. Routine campaign scan counts live in Promotion details,
while partial data and recovery remain visible. Mark simulated verification
explicitly in prototypes and repeat reviews with the implemented components.

Keep meaningful pixel labels at least 10px and check their contrast against the
actual panel background, including each rank tier. Unselected amount and position
choices retain a visible cyan edge and light fill; selected choices use a pink
fill. Disabled controls remain visibly subdued.

The shared `Modal` keeps controls and QR codes above the CRT scanline overlay.
Retain the effect on the board and background. Its scrolling body leaves the
action footer visible and stable across mobile editor stages and contextual
panels; compact boosts retain their smaller layout. Reuse `StatusMessage` for loading and empty states.
Its symbols are decorative, its text is exposed as a status, and its loading
blocks follow the shared reduced-motion rules. All visible loading labels use
the pixel font, including compact connection, preview, profile and wallet
states. Use 12px for full loading panels and 10px for compact labels, leaving
ordinary explanations and completed or unavailable status text in the body font.

[Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P), by CodeMan38,
is bundled as WOFF2 under the SIL Open Font License 1.1.
