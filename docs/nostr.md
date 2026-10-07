# Nostr reads and delivery

Holoboard ranks paid notes through its HTTP API. Public profiles, quotes and
receipt discovery use a separate bounded read service. Public-relay results
never change board ranking. Discussion and profile screens can build on these
primitives without adding another relay pool.

## Reading

`web/src/lib/nostrTransport.ts` multiplexes subscriptions on one read socket per
canonical relay URL. The board connection indicator uses that same transport.
NDK supplies event models; its outbox pool, subscription scheduler and Dexie
adapter are not active. IDs and signatures are verified with `nostr-tools` on
fresh event objects, removing cached verification flags first.

`nostrReads.ts` queries reference hints and configured relays while discovering
the author's NIP-65 write relays. `nevent`, `naddr`, `q` and `nprofile` references
retain their authors and relay hints. Discovery requests and profile requests
are deduplicated. Observed relay lists survive a deadline, and every query
owns its cancellation and CLOSE cleanup.

An exact verified ID can finish immediately without EOSE. Replaceable events
are compared by timestamp and then lowest ID. `QueryResult` retains events,
source relays and per-relay outcomes: EOSE, timeout, CLOSED, failure, budget,
cancellation or an exact match. `complete` means the selected relay requests
received EOSE; it does not mean the whole Nostr network was searched.
A cached immutable event is useful without claiming network completeness.
Outbox reads can displace lower-priority fallback reads when the pool is full;
displaced queries report budget exhaustion. Board status pins its shared socket.
An unavailable author outbox never establishes global absence.

`nostrHistory.ts` uses inclusive `until` cursors, deduplicates boundary IDs and
expands a saturated timestamp up to 512 events. It reports truncation instead
of skipping a full timestamp silently. It retains separate exhaustion and
transport completeness. The common cursor preserves each full relay page's
unseen range; failed sources require retrying the page before advancing.
The discussion normalizer and bounded metadata graph distinguish root claims
from direct parents for NIP-10/NIP-22, including address and exact-version
references, missing parents and explicit conflicts. `discussionReads.ts`
coordinates network reads into that graph; an opt-in read-only screen consumes
the shared service. The older `threadContext`
helper still serves best-effort context links. Read the
[client comparison and relation-model contract](nostr-discussions.md) before
building discussion screens; it records the implemented guarantees and remaining
coverage and browser checks.

Backend exact-ID lookup returns a verified event before EOSE. HTTP preview and
promotion return 404 only after completed selected-relay searches, 504 for a
deadline, and 503 for unavailable or busy discovery. Author discovery failures
remain inconclusive. Existing successful response fields are unchanged.

### Discussion retrieval

Use the shared `discussionCoordinator` from `discussionReads.ts`. `open` takes
the original promoted event's exact `focusId`, an optional author hint or signed
`seed`, safe relay hints, an optional view-lifetime signal and an update callback.
Views of the same focus share a session and in-flight `loadMore` batch. Each view must
close its handle; only the last close cancels shared work. All active discussions
share one bounded metadata graph. A new session after all work has closed resets
that graph, leaving the independent read cache available.

`loadMore` resolves ancestors separately from descendant discovery. Exact
parents use hints, observed sources, configured fallbacks and known authors'
NIP-65 write relays. Candidate replies use those fallback/hint/source groups and
the focused authors' read relays. Relay-list discovery also uses reference and
observed-source hints. An author's outbox is not treated as an index of unknown
respondents. Sources are bounded and each selected relay has its own branch,
outcome and inclusive pagination cursor.

Candidate filters cover NIP-10 `e` and NIP-22 `e/E/a/A` tags. Signed, matching
events pass through the existing normalizer before graph admission; a matching
tag alone does not establish a parent. Valid missing parents and roots are
resolved, but only connected descendants become new discovery targets.
Promotional quotes, ranking and payment state never supply graph edges.
An exact old address version is fetched by ID even when the replaceable cache
already holds a newer version. External scopes never become HTTP fetches.

Snapshots expose per-source coverage, routing outcomes, local retention loss,
resource limitations and the fixed descendant `until` timestamp selected when
the session opens. `settled` means the selected work has stopped, including
exhausted searches for still-missing parents; it never promises network-wide
completeness. Cached replies do not exhaust a network branch. Failed sources
keep their cursors and retry on a later batch while successful sources advance.
Transient transport budgets remain retryable; saturated timestamps at 512
events, oversized events and hard lifetime budgets remain explicit limitations.
Opening a fresh session refreshes the upper timestamp. This service does not
yet subscribe to live replies or render reply bodies, deletions or profiles.

Every network request uses `withReadBudget` and `queryNostr`; there is no new
socket pool. Global admission bounds concurrent work across discussion sessions
and existing reads. Event metadata is reduced in batches of at most 32, with
streaming updates scheduled with a 16 ms timer and a flush on request completion.
Batches yield between requests so queued data cannot starve deadlines or
navigation. The final close also stops a read waiting for a shared
handshake without closing another reader's connection or releasing that
handshake's physical dial slot early. Idle cleanup checks connection identity
and cannot evict a replacement socket after an earlier handshake failed.

## Discussion screen

Set `VITE_ENABLE_DISCUSSIONS=true` to enable read-only discussions; it is false
by default. This flag does not enable signer entry points or publication.
Board and expired-note footers link to `/discussion/<exact-event-id>`, with an
optional author hint. URLs accept canonical hexadecimal IDs. The `from`
parameter preserves a board section and waiting-room sort without allowing an
external redirect. Board navigation seeds the cache only after fresh signature
and ID verification.

The original event remains the focus, with ancestors in parent-edge order and
expandable descendants. Siblings use ascending timestamps with an ID tie-break;
same-author continuations use the same policy. Promotion badges join the current
ledger by exact ID and cannot change topology, ordering or board membership.
Missing context remains explicit. Candidate branches with a root claim but no
resolved path to the focus appear separately as unresolved branches. Opaque
external scopes never acquire Nostr-address alias semantics.

Each connected/unresolved reply page renders at most 48 notes. Remaining found
replies are accessible through local pages. Eight nearest ancestors appear
initially; earlier context can be revealed within the existing graph depth cap.
Collapse is a display choice and does not reduce network/graph budgets. Existing
safe text rendering is reused, with automatic quote/link previews held on this
screen to avoid extra embed trees. Profiles use the shared bounded reader.
Cache-evicted bodies remain placeholders. Deletion/moderation discovery is not
added by this screen.

Internal discussion navigation keeps the board mounted. Reading positions use
browser history and an in-memory map of at most 16 locations. Branch expansion,
explicit collapse, local pages and context expansion survive reloads through
session storage for at most eight discussions, separately from payment and
identity storage. Late parents expose the path to an already opened branch;
explicit collapse takes precedence. Graph updates preserve a visible reading
anchor when that row remains rendered. Media resizing and browser scroll
clamping are not covered by a universal no-jump guarantee.

The counter names found connected replies, not a network-wide total. Source
completion, partial results and local retention limits remain distinct.
`Load more` starts another bounded batch. The displayed opening timestamp is
fixed; closing and reopening checks newer replies. Leaving closes the view's
handle and cancels outstanding reads when it was the final view.

### UI lifecycle and browser verification

Reader startup and cleanup must tolerate React StrictMode effect replay. Do not
open a replacement handle into a still-closing session during that replay.
Keep delayed startup cancellation-aware and close only the owning view handle.
`useDiscussion.ts` provides the current integration pattern.

Browser fixtures should wait for a batch to become `paused` or `settled` before
requesting another batch. An enabled `Load more` button can belong to a
transitional snapshot and disappear before a click. Run each feature-flag
configuration against a matching fresh Vite server; flags are build/server
configuration, not runtime URL switches. Preserve separate checks for the
production default and the enabled screen.

## Profile screen

Set `VITE_ENABLE_PROFILES=true` to enable `/profile/<hex-public-key>` and local
author/mention links. The flag is false by default and independent of
`VITE_ENABLE_DISCUSSIONS` and signer support. Disabled profiles retain the
existing external profile links. Both screens can run without an account.

`profileReads.ts` shares metadata work between bylines and profile views.
Cached kind-0 data renders immediately; opening the screen checks configured
sources and the author's discovered NIP-65 write relays. Leaving closes the
view's handle, and the last close cancels work, including relay discovery and
queued admission. A returning view joins cancelled work before starting a fresh
read. React StrictMode startup uses the same cancellable microtask pattern as
discussions. Empty checked sources, failed sources, malformed latest metadata
and cached data remain distinct. A cached read alone never extends its TTL.

Profile ordering follows [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md):
newest timestamp, then lowest ID. Fields follow kind-0 metadata and
[NIP-24](https://github.com/nostr-protocol/nips/blob/master/24.md).
The screen shows a name, biography, safe website, public key and avatar.
NIP-05 is a claimed, explicitly unverified address. No domain verification,
automatic biography embeds, follower counts, profile editing or public event
publication are added. Website and image URLs reject unsupported schemes and credentials;
React text nodes keep signed markup inert.

Active promoted notes come from Holoboard's existing campaign API, joined to
verified exact event IDs and authors. The initial read checks TOP 21 and one
waiting-room page. Each `Load more promotions` checks one further page; the
screen states the checked range and any remaining pages or errors. Rank comes
from the board, not public tags. A promotion does not imply the author paid for
it. The initial version excludes expired promotions and the author's general
public-note feed. Empty checked pages do not claim the author has never been
promoted. Concurrent campaign changes can move entries between pages, so the
scan is not an atomic snapshot; IDs are deduplicated and reads are bounded.

Readers preserve safe local return paths and waiting-room sorts. Discussion
branch state and history scroll positions survive profile navigation under the
existing bounded storage rules. Return URLs allow at most two nested reader
levels and never arbitrary external destinations. The profile list renders 21
notes per local page; note previews reuse safe rendering without automatic
quotes or link cards. Signature-verified bodies live in the shared expendable
cache, and evicted bodies remain explicit placeholders.

## Resource limits

These are application defaults, not protocol requirements. Byte estimates in
the browser use three bytes per JavaScript string unit as a conservative bound.

| Resource | Browser | Backend |
| --- | --- | --- |
| Outbound sockets | 12 across reads, wallet and signer; 8 read sockets | 32 across lookups, monitors, delivery and receiving wallet |
| Concurrent dials | 4 overall, 3 for reads; 32 queued read dials | 8; bounded by socket admission |
| Sockets per relay | 3 across consumers, one in the read service | 4 per configured host and port |
| Active subscriptions | 48 overall, 8 per relay | 48 overall, 8 per relay |
| Main lookup admission | 4 reads, 64 queued; 16 transport queries | 8 note lookups, 8 metadata lookups |
| Candidate relays | 12; 4 author write relays | 12; 4 recipient read relays per tagged person |
| Message size | 1 MiB conservative estimate | 1 MiB after decompression outbound; 512000 bytes inbound |
| Receive traffic | 640 messages and 16 MiB per second overall; 200 messages and 5 MiB per socket | 512 messages and 16 MiB per second outbound; 1024 messages and 16 MiB inbound |
| Query retention | 512 events and 5 MiB | 512 events and 4 MiB |
| Read cache | 2048 events and 8 MiB, including signatures | 256 immutable notes of at most 8 KiB each; 256 metadata entries of at most 8 KiB each |
| Discussion sessions | 4 active/closing sessions and 16 view handles; one shared graph with 2048 events, 6144 nodes and 8 MiB | Not applicable |
| Discussion session work | 64 descendant targets, 64 ancestor lookups, 256 branch/source records, 8 relays per predicate, 8 author discoveries; 128 queries over its lifetime, 16 per batch, 16 page attempts per descendant branch | Not applicable |
| Discussion admission | 1024 observed events, 4 MiB of received serialized events, 256 KiB per event; 30-second batches and 4-second queries | Not applicable |
| Profile metadata | 64 active/closing author reads, 256 view handles; 64 KiB per signed profile, six fields of at most 2048 characters each; 12-second reads, 4-second discovery and 6-second metadata queries | Not applicable |
| Profile campaign scan | 8 pages of at most 21 entries, 128 retained note references, 64 KiB per admitted event; one 8-second HTTP request at a time per view | Existing campaign API, no new route |
| Incoming relay clients | Not applicable | 128 clients, 16 listener filters per client, 1024 filters overall, 8 filters per REQ, 32 stored-event queries |

The browser cache has its own `holoboard-nostr-read-v1` database. It expires
profiles after 15 minutes, relay lists after 5 minutes, ordinary events after
one day and observed deletion requests after 30 days. Matching precedes sorting
and limits; tag count does not remove an event from the index. Authored deletion
requests suppress only matching events of that author. Eviction bounds deletion
retention, so the cache is not an authoritative deletion archive. Invalid profile
field types are discarded. A declared NIP-05 string has no verified badge.

The old `holoboard` Dexie database is left untouched and is not read or expanded.
The new limits apply to the active cache, not historical browser storage from
older releases. Wallet secrets, payment attempts and invoice sessions use their
existing storage and are never pruned by this service.

Backend note-cache entries expire after one hour. Metadata expires after five
minutes, or 30 seconds after a partial result or a completed empty search.
Incomplete empty searches retain an inconclusive five-second retry cooldown,
not a cached absence. Short metadata
lookups share an in-flight request. No backend cache is part of the payment
ledger.

## Relay policy and monitors

Untrusted backend hints, NIP-65 destinations and NIP-17 inboxes require WSS on
port 443 without credentials or fragments. At dial time all DNS answers must
be public addresses, and the connection uses those checked IPs while TLS still
verifies the original hostname. Loopback, private, link-local and special-purpose
ranges are rejected. Exact URLs explicitly supplied in backend configuration
can opt into local relays for development; event data cannot grant that trust.

Browsers cannot resolve and pin DNS. They reject untrusted literal IPs, local
hostname forms, credentials and insecure hints. This is URL filtering, not a
browser-side DNS rebinding guarantee. Configured preview relay URLs remain
available. Public metadata discovery is reading only and never adds publication
or monitor destinations.

Zap, DM and mention streams retry independently with cancellation-aware backoff.
Zap shutdown joins its workers. A full initial history window triggers bounded
pagination, with inclusive timestamp ties and deduplicated IDs. Backfill has
four process-wide slots, a 30-second deadline, 32 pages and 4096-event retention.
Failures, saturation and budget exhaustion log an explicitly incomplete backlog.
Reconnects retry discovery; none of these windows promise complete lifetime
history. Current windows are 30 days for zaps, 24 hours for mentions and the
existing DM watermark/lookback policy. Gift-wrap envelope lookback remains
separate from the decoded DM command's age check.

## Publication

Account publications retain one signed event and per-relay acknowledgements in
the durable outbox. Before delivery, pending public replies and quotes discover
up to four tagged recipients' NIP-65 read relays and persist additional targets.
A failed storage write prevents publication. Retries reuse the same event ID.
Instruction and error replies also use the outbox when the publisher is active.
Deletion requests retain the original quote's destinations.

NIP-17 delivery still uses only the recipient's verified kind 10050 inbox list.
Public read relays are not a fallback for private messages. An empty
`PUBLIC_BOARD_URL` does not enable new public recipient routing in a preview.
No private relay key is logged when an ephemeral identity is generated.

## Inspected dependencies

| Dependency | Confirmed behavior and application response |
| --- | --- |
| fiatjaf.com/nostr at 685c38fc6629, vendored | Typed IDs/keys require explicit hex boundaries. Signature verification needs a separate CheckID. Local patches retain joined shutdown, backpressure, bounded decompression/subscriptions, partial queries and actual EOSE. Canonical backspace/form-feed escaping, strict hex decoding and kind range checks have reproducing regressions. |
| Khatru from the same module | Upstream dispatches each frame in a goroutine and uses mutable listener indexes. Local processing preserves wire order, cancels stored queries on CLOSE and enforces shared client/listener/query/receive limits. Broadcasts use synchronized snapshots and full filter matching. |
| coder/websocket 1.8.13 | Replaces the old gobwas client transport. A DNS-pinned HTTP client disables redirects. Compression round trips are tested against fasthttp/websocket, and oversized decompressed messages close the connection. The old wsflate Flush patch is no longer on the active path. |
| NDK 2.18.1 | Discovery timeout can discard observed lists without stopping the subscription; stop can precede a delayed start. Application reads bypass these paths. |
| NDK React 1.3.12 | Profile reuse has no freshness policy and accepts arbitrary JSON field types. The application profile hook uses a validated, expiring cache and deduplicated reads. |
| cache-dexie 2.7.7 | Ten indexed tags can erase the index; some paths limit before final matching; persistent storage is not bounded by the memory LRU. The adapter is inactive. |
| nostr-tools 2.25.2 | Verification can reuse a symbol cached on an event object. Fresh canonical objects are verified at application ingress. Existing Schnorr and encoding implementations remain in use. |
| Alby SDK 8.0.3 | Its dynamically loaded NWC transport uses WebSocket and shares the bootstrap socket/REQ limits. Existing payment proofs and uncertain-attempt protection remain in the payment layer. |

These observations are version-specific. Relay availability, real-world traffic
and platform DNS behavior require deployment observation; local tests do not
establish their production reliability. No live wallet spending is part of the
test suite used for this change.

The `nostr-tools` verification flag is an in-memory symbol. Spreading a verified
object can copy that symbol, so mutating the copy can reuse a stale verification
result. Relay JSON does not transport symbols. This finding demonstrates a local
object-mutation hazard, not a demonstrated remote JSON signature bypass.

## Pinned Go Nostr transport

Both archived [go-nostr](https://github.com/nbd-wtf/go-nostr) and
[Khatru](https://github.com/fiatjaf/khatru) direct users to the successor.
Holoboard now pins `fiatjaf.com/nostr v0.0.0-20261005012418-685c38fc6629`,
including its Khatru package. The retained package closure, upstream checksums,
license and reproducible patch are documented in the
[snapshot rationale](../relay/third_party/nostr/WHY.md).
The candidate requires Go 1.25; Holoboard declares Go 1.27.1.

Existing IDs, authors, references and ledger keys remain hexadecimal strings.
Unknown event fields survive ledger saves without entering the canonical hash.
The new `ID.String()` and `PubKey.String()` prefixes are never used at these
boundaries. NIP-19 `note` now decodes to an EventPointer; a missing pointer
author remains absent rather than becoming a zero-key hint. NIP-44 now
generates its nonce correctly, so the previous workaround is removed.
The unused mention-monitor pool is removed. New reads must use the shared
application transport and admission controls.

Confirmed upstream findings have local regression coverage: `VerifySignature`
does not bind the supplied ID, local EOSE timers invent completeness, event
delivery spawns workers without backpressure, frame dispatch loses REQ/CLOSE
ordering, canonical serialization omits required backspace/form-feed escaping,
and decoding can wrap an overflowing kind or accept malformed hexadecimal
input through an architecture-dependent fast path. Local changes retain or
restore the documented contracts. Canonical bytes follow
[NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md);
signing, encryption and key derivation use the library's implementations.

A fixed historical signed-event fixture checks event JSON, payment and invoice
records and durable publication destinations across load/save/reload.
Existing NWC protocol tests cover NIP-04 and NIP-44, and relay tests cover
private destination rejection, redirect refusal, exact-ID reads, partial
queries, limits, cancellation, compression, HTTP timeouts and listener races.
These checks do not establish live wallet, device or unused-library-feature
compatibility. No production data migration or public publication is required
for this dependency change.

## Signer compatibility and publishing gate

Reliable account connection is a prerequisite for user-authored publication.
Keep `VITE_ENABLE_NOSTR_CONNECT` disabled by default until the signer release
passes its own acceptance checks. Reading and anonymous invoice payments remain
available independently of signer support.

Reported Amber connection failures need reproduction; their cause is not yet
established. Current code exposes a browser extension and NIP-46 remote flows,
including `nostrconnect://` and pasted `bunker://` strings. Both remote connection
paths currently request only `sign_event:9734` (zap requests). This is a confirmed
limitation of the requested permissions for future publishing, not a confirmed
explanation of the reported connection failures. No direct NIP-55 web adapter
is implemented.

Track compatibility by method, signer version, OS and browser:

| Method | Required evidence before claiming support |
| --- | --- |
| [NIP-07 browser signer](https://github.com/nostr-protocol/nips/blob/master/07.md) | Account access and signing in supported desktop browsers; extension absent, rejection and account changes handled. |
| [NIP-46 remote signer](https://github.com/nostr-protocol/nips/blob/master/46.md) | Both client-initiated and signer-initiated pairing; same-phone Amber handoff and return; desktop-to-phone QR; a second independent signer; reconnect and permission changes. |
| [NIP-55 Android signer](https://github.com/nostr-protocol/nips/blob/master/55.md) | Evaluate a direct web flow separately from NIP-46, with real-device callback/clipboard, cancellation and request-correlation checks. Do not label it supported before implementation and verification. |

For each supported path, verify identity, a signed event for each enabled
publishing action, explicit user consent, signature and template validation,
relay acknowledgement, partial delivery, safe retry and duplicate prevention.
Connecting an account must not publish anything. Test rejected and timed-out
requests, backgrounding and returning to the page, expired permissions,
disconnect/reconnect and stale responses after account changes. Keep the draft
through these transitions and isolate signer state from payment state.

Automated protocol tests do not establish Amber/device compatibility. Record
actual device, browser and signer versions and distinguish tested combinations,
unsupported combinations and unresolved failures. The goal is reliable access
through every supported method; a universal compatibility claim requires
evidence beyond a successful handshake or mocked signer.

## Regression checks

Inspect the installed or vendored version before attributing behavior to a
library. Retain regression fixtures when upgrading. From `relay/`, include the
nested vendored module explicitly, since Go's `./...` does not traverse it:

```sh
GOMAXPROCS=2 go test -race -p 1 -count=1 -timeout=8m ./... fiatjaf.com/nostr/...
```

Use the toolchain declared in `relay/go.mod`. With an older local Go and
`GOTOOLCHAIN=local`, run the command with `GOTOOLCHAIN=auto` or install the
declared version explicitly. Include the nested vendored module: its compression
fixture caught a toolchain compatibility issue not covered by application-only
tests.

Browser checks should include Chrome and WebKit, slow or absent EOSE, cache
reloads and anonymous invoice access. Use Playwright's default port 4173, or a
known browser-allowed alternate port. WebKit blocks port 4190 before the
application loads; inspect console and trace output before diagnosing a
page-load timeout as an application regression.

## Acceptance and rollout

### Delivery stages

This reference owns the delivery sequence. Keep stage status and acceptance
current here; keep detailed discussion semantics in
[the discussion design](nostr-discussions.md).

| Stage | Current state | Completion evidence |
| --- | --- | --- |
| Foundation and relation engine | Reviewed and locally verified with current production fixes; ready for integration. | Shared transport/cache/discovery and relation-contract regressions, full Go race suite, frontend unit/build checks and browser coverage. |
| Go library migration | Implemented and locally verified; ready for integration, not deployed. | Pinned revision, reproducible patch, historical-format fixture including unknown fields, full Go race suite, Linux builds and payment/browser regressions. |
| Discussion retrieval | Implemented and locally verified; consumed by the opt-in reading screen. | Bounded discovery and missing-parent retrieval, cancellation, pagination and honest per-relay coverage, feeding the shared relation engine. |
| Discussion reading | Read-only screen implemented behind `VITE_ENABLE_DISCUSSIONS`, disabled by default. | Original-item focus, expandable paid/unpaid branches, unresolved context, bounded display pages and local browser navigation checks. |
| Profile reading | Read-only screen implemented and locally verified behind `VITE_ENABLE_PROFILES`, disabled by default. | Shared bounded metadata reads, explicit freshness/source outcomes, verified active campaign membership, discussion return navigation and selected public-relay reads. |
| Signer compatibility | Disabled by default; Amber failures unresolved. Begin reproduction early. | Record tested methods and environments, validate connection and signing, preserve drafts and handle account/lifecycle changes. |
| User-authored publication | Not implemented. | Correct reply references, explicit consent, verified signed payloads, delivery outcomes and retry without duplicate events. |

Keep stages reviewable and independently releasable where their dependencies
allow. Before closing a stage, compare the final diff to its acceptance criteria
and record unresolved limitations. Persist the next concrete action or blocker
so another session can resume. Routine authorized implementation and checks do
not need repeated approval; deployment, public publication and existing-data
migration retain their explicit approval requirements.

### Current verification and next action

The isolated discussion screen branch includes the foundation, pinned library
migration and production fixes through `e651ac6`, including ordinary LNURL invoices and
the current payment and waiting-room interface.
The application and every retained dependency package passed the Go race
suite. Additional regressions check the global subscription cap, malformed
frames, escaped subscription IDs and forged authentication IDs. Frontend
verification passed 293 unit tests and production builds with discussions
disabled and enabled. Four wire checks use the actual transport, and discussion fixtures cover discovery,
recovery and resource limits. Across desktop Chrome, Android-sized Chrome and
iPhone-sized WebKit, 21 discussion scenarios passed. A further 36 selected
reading, anonymous-invoice, NWC, disabled-feature and waiting-room checks passed.
Browser fixtures use local protocol mocks and no live funds. ESLint passed for
the changed screen, navigation and test modules. The backend is unchanged from the verified retrieval stage; its Go race and Linux build
evidence carries forward.

Both backend binaries build for Linux amd64 with CGO disabled. The Docker
image has not been built in this environment because the local daemon is
unavailable. A container build and the documented release smoke checks remain
part of release verification. Amber device compatibility, live-wallet behavior
and public publication are outside these local checks. Signer entry points
remain disabled by default.

The bounded discussion retrieval coordinator now feeds the existing relation
normalizer and graph. Its fixtures cover a promoted middle reply, unpaid
intermediate parents, NIP-10 and NIP-22, missing/conflicting references, partial
relay coverage, timestamp saturation, routing hints and shared-view cancellation.
Wire tests exercise signed frames through the actual read transport.
The read-only discussion screen now consumes this service behind a disabled
feature flag. Its focused ancestor path, expandable replies, explicit unresolved
branches and promotion badges keep display decisions outside the relation core.
Reproducible real-relay and production-bundle resource checks are described
below. They cover selected public reads and finite navigation workloads, without
claiming complete discovery or universal absence of memory leaks.

Profile checks passed 306 frontend unit cases, followed by 14 focused cases
including an additional invalid campaign-count regression. The combined enabled
profile/discussion browser suite passed 42 scenarios across the three browser
projects; the amended profile suite passed its 21 enabled scenarios. A further
27 selected default-release checks passed with both screens and signer support
disabled. Enabled and default production builds and changed-module lint checks
pass. Independent profile/discussion flag configuration has a separate desktop
check. No payment or identity storage is removed by the new screen.

Profile reading is locally verified. The next
stage reviews combined changes and reproduces signer failures by connection
method, followed by preparing user-authored replies. Continue routine work
autonomously through these stages; keep external publication, spending,
deployment, main pushes and existing-data migrations behind explicit approval.
Physical-device and live-wallet evidence remains open when unavailable and does
not block unrelated implementation. Deployed-client interoperability remains
separate from local automated checks. Integration does not enable signer support.

### Real-relay and runtime resource checks

Run the public-read smoke against an isolated local development server with
discussions enabled, signers disabled and public read endpoints configured:

```sh
cd web
VITE_ENABLE_DISCUSSIONS=true VITE_ENABLE_NOSTR_CONNECT=false \
  VITE_RELAY_URL=wss://relay.holoboard.space \
  VITE_API_URL=https://relay.holoboard.space \
  VITE_SATS_ENDPOINT=https://relay.holoboard.space/api/board \
  npm run dev -- --host 127.0.0.1 --port 4194 --strictPort
# In another terminal, from web/:
HOLOBOARD_LIVE_READS=1 node scripts/discussion-live-smoke.mjs
# To include profiles, also enable VITE_ENABLE_PROFILES on the server and run:
HOLOBOARD_LIVE_READS=1 HOLOBOARD_PROFILE_READS=1 node scripts/discussion-live-smoke.mjs
```

The script requires explicit public-read opt-in and a loopback preview origin.
It blocks non-read WebSocket frames before sending and blocks non-read HTTP
methods. It selects a promoted kind-1 root and kind-1111 comment from the public
board, then attempts a kind-30023 article read. Missing required board fixtures
fail the smoke; unavailable article discovery stays explicit in its JSON report.
The optional profile case checks the promoted comment author's metadata and
active campaign membership, then closes its owning handle. Reports omit full
profile biographies and contact fields. Reports and screenshots go to temporary storage. Source outcomes, skipped work,
resolved ancestry, read scopes, socket peaks and idle cleanup remain separate
observations. Development-module inspection supports this smoke and is not a
production heap measurement.

Run the offline resource suite against a freshly built production bundle:

```sh
cd web
VITE_ENABLE_DISCUSSIONS=true VITE_ENABLE_NOSTR_CONNECT=false npm run build
HOLOBOARD_RESOURCE_CHECKS=1 npx playwright test \
  --config playwright.resources.config.ts
```

The suite intercepts all remote traffic. A fresh browser context receives 518
signed fixtures through the expendable IndexedDB read cache, then reloads for
normal verification and hydration. Four roots each have 128 direct replies;
only 48 replies render per local page. The desktop test rotates through all four
roots for 24 open/close cycles, collects garbage through CDP after leaving each
view and compares retained JavaScript heap medians after warmup. Its explicit
allowance is the larger of 2 MiB and 20 percent of the reference median. This
checks cache-backed graph and view lifetimes, not bulk network ingestion or
total browser/process memory.

Eight additional navigation cycles per browser project cancel relay reads that
never send EOSE. Relay-side counters independently observe REQ/CLOSE, connection
closure and the socket/subscription ceilings after the application's governor.
They must observe nonzero activity before their upper bounds can pass. Do not
rely on a native-WebSocket wrapper installed before Playwright routing: routing
can replace that wrapper and leave an apparently successful zero-valued probe.
In the installed Playwright version, `waitForFunction` treats a returned promise
as truthy before its boolean result resolves. Keep its predicate synchronous;
poll asynchronous module inspection with awaited `page.evaluate` calls and an
explicit deadline (or `expect.poll` in tests). Assert the final observed state
separately so an ineffective wait cannot pass cleanup verification.
Heap measurements run only on desktop Chromium. Mobile-sized Chrome and WebKit
exercise cancellation and idle cleanup, not physical Android/iPhone devices.

Verified on 2026-10-07: the public smoke loaded all three event kinds. The
promoted NIP-22 middle comment resolved its parent and matched its root; the
article scheduled `#e`, `#E`, `#a` and `#A` reads. Relay failures and unqueried
branches remained explicit, so this is selected-source evidence. Actual socket,
connecting-socket and REQ peaks stayed within 12, 4 and 48 respectively, with no
write frames or page exceptions.

The profile-enabled public smoke also loaded the selected author's metadata and
one active promoted note from two campaign pages (38 entries). Metadata sources
completed; this is selected-source evidence, not global absence or completeness.
After background board reads finished, the native wire probe and application
governor both returned to zero REQs and one closing socket. Observed peaks were
12 sockets, four connecting sockets and 40 REQs, with no write frames or page errors.

Four resource scenarios passed: one desktop heap workload and one cancelled-read
workload on each of the three browser projects. The two mobile-project heap cases were
intentionally skipped. With the profile reader included, post-GC heap medians
increased from 7,351,940 to 7,539,292 bytes (187,352 bytes, about 0.18 MiB),
within the 2 MiB allowance. This workload measures discussion lifetimes after
the shared profile-reader change; it does not measure repeated profile-screen heap use.
Mock-relay peaks were seven sockets and eight subscriptions. Leaving each view
closed its pending requests; idle socket counts fell to at most one. These
finite measurements support the stated lifetime bounds, not a claim that every
memory leak is excluded. JSON reports accompany test output.

Closing a discussion cancels its owned work. The mounted board can still perform
its own bounded profile reads, and native sockets can remain in CLOSING while
the relay completes the close handshake. Record active requests, open sockets
and closing sockets separately. A short wait for every physical connection to
disappear can otherwise misidentify shared work or handshake delay as a leak.

### Verification ownership and release gates

Continue implementation and automated verification without waiting for the
maintainer to provide a device, wallet or manual test session. Pending external
checks do not block discussion retrieval development in the isolated worktree.
The implementing agent owns repeatable local protocol, recovery, browser and
build checks, including automation for additional reproducible failures.

Keep release evidence scoped to what was exercised. Local DM and NWC tests do
not establish interoperability with an independent client or a live wallet.
Before releasing the migrated backend, complete the container build and
controlled interoperability checks for existing DM, payment and publication
flows. Amber device checks gate the signer release; signer entry points remain
disabled in the meantime. Record unavailable checks as open release gates,
without marking them passed or assigning routine verification to the maintainer.

`TestProductionDMFlow` is opt-in and is skipped by the default Go test suite.
It publishes public discovery metadata and sends a production DM that creates
an unpaid invoice. Do not use it as an automatic substitute for isolated tests;
its external actions require the explicit authorization described above.

### Release checks

Security, connection lifetime, discovery, cache, thread primitives and durable
routing can ship as one foundation change. New discussion/profile screens and
actual NIP-05 domain verification remain separate features.

Acceptance checks cover forged IDs and verification flags, private and mixed
DNS answers, an event without EOSE, partial profiles on timeout, cancellation
before REQ, shared socket budgets and multiplexing, signed malformed metadata,
cache matching/expiry/deletions/byte bounds, timestamp pagination, monitor
reconnect/shutdown/backfill, and delivery targets persisted before publication.
Browser regressions cover slow quotes, cache reloads, anonymous invoice copy/QR,
NWC uncertainty and disabled signer entry points.

The foundation adds no frontend/backend version coupling: successful API fields
and ledger record shapes remain compatible, and there is no data migration.
Follow the current [release verification and rollback procedure](../relay/DEPLOYMENT.md#release-verification-and-rollback),
including backend checks before publishing a frontend that needs newer routes.
Other work can be released from the main checkout while this branch stays
isolated. Rerun acceptance checks after integration. Preserve the existing
production volume, identity and secrets. Code rollback must preserve the current
ledger and receipts, including payments recorded since any backup. The separate
read cache is expendable and the old cache remains available to an old frontend.
Actual deployment, public publication and external configuration changes still
require explicit authorization.

Protocol references: [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md),
[NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md),
[NIP-10](https://github.com/nostr-protocol/nips/blob/master/10.md),
[NIP-22](https://github.com/nostr-protocol/nips/blob/master/22.md),
[NIP-05](https://github.com/nostr-protocol/nips/blob/master/05.md),
[NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md) and
[NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md).
