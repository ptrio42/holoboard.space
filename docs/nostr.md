# Nostr reads and delivery

Holoboard ranks paid notes through its HTTP API. Public profiles, quotes and
receipt discovery use a separate bounded read service. Public-relay results
never change board ranking. Discussion and profile screens can build on these
primitives without adding another relay pool.

## Reading

`web/src/lib/nostrTransport.ts` multiplexes subscriptions and explicit public
delivery acknowledgements on one socket per canonical relay URL. The board
connection indicator uses that same transport.
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

Public mention/reply destinations come from `read` entries in verified
[NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md) kind-10002
lists. The separate [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md)
kind-10050 DM lists do not supply discussion sources. A URL ending in `/inbox`
can serve both roles; the path alone does not identify its purpose. Preserve
the complete relay path instead of replacing such addresses with the host root.

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
descendants expanded by default. Siblings use ascending timestamps with an ID tie-break;
same-author continuations use the same policy. Promotion badges join the current
ledger by exact ID and cannot change topology, ordering or board membership.
Missing context remains explicit. Candidate branches with a root claim but no
resolved path to the focus appear separately as unresolved branches. Opaque
external scopes never acquire Nostr-address alias semantics.

Each connected/unresolved reply page renders at most 48 notes. Remaining found
replies are accessible through local pages. Eight nearest ancestors appear
initially; earlier context can be revealed within the existing graph depth cap.
Collapse is a display choice and does not reduce network/graph budgets. Existing
safe text rendering is reused. Replies and direct-URL reading suppress automatic
quote/link previews to avoid extra embed trees. A board-origin focus reuses the
board card, including its existing bounded previews. Profiles use the shared
bounded reader.
Cache-evicted bodies remain placeholders. Deletion/moderation discovery is not
added by this screen.

Internal discussion navigation keeps the board mounted. Reading positions use
browser history and an in-memory map of at most 16 locations. Board/discussion
transitions record an exact event ID and its viewport offset, with the old scroll
value as fallback. The board-origin focus uses the shared `BoardRow` at board
width, with the clicked rank, paid appearance and body expansion. Signed bodies
stay in the verified read cache. Public presentation snapshots are bounded to
16 records and 16 KiB of serialized UTF-8 per record. These snapshots describe
appearance, never protocol relationships or campaign admission. Direct URLs and
missing snapshots use the ordinary discussion focus.

`useReadingPosition` owns history restoration across board, discussion and
profile views. It applies before paint, then observes delayed content for at most
35 seconds, stopping on user interaction or navigation. Bounded spacing above
the anchor and below the surface allows alignment near document edges. The
retained board restores the same event offset even when polling inserts earlier
rows. If the event disappears, the saved scroll value is the fallback. Browser
Back/Forward and explicit return links use the same restoration. During
restoration, native scroll anchoring is disabled on the active surface to avoid
competing adjustments; normal board scrolling keeps browser anchoring.
Known author metadata, cached quote/link previews and overflow measurements
are available before the first paint of a remounted card. Newly arriving metadata
or media can still change its height during a read.

Explicit branch collapse, local pages and context expansion survive reloads through
session storage for at most eight discussions, separately from payment and
identity storage. New and late-parent branches open automatically unless an
ancestor was explicitly collapsed. Each resolved reply names its actual parent
author. Direct replies to the reading focus omit its repeated text preview;
nested replies retain a one-line cached preview with shortened references and
media labels. Selecting that context reveals and
focuses the parent, including on an earlier local page or in hidden ancestor
context. Parents beyond the projection use an exact discussion link instead.
The `Thread` action (accessible name `Open thread`) makes the selected note the
reading focus without changing its protocol ancestry or promotion status.
Graph updates preserve a visible reading
anchor when that row remains rendered. Media resizing and browser scroll
clamping are not covered by a universal no-jump guarantee.

Replies use compact rows with continuous branch rails and a maximum four visual
indentation levels. Exact parent links retain the full relationship when depth
exceeds that display cap. The reading focus keeps its notched frame; promoted
replies use a gold marker, label and subtle background without changing ordering.
The reply column and direct-URL focus are at most 768 CSS pixels wide; a
board-origin focus retains the board width. Branch collapse sits beside
the author; body expansion and navigation share a subdued footer. Controls keep
44-pixel hit heights. Local page changes focus and scroll to the reply section,
and a page starting inside a branch names that continuation and keeps its parent
link available.

The counter names found connected replies, not a network-wide total. Source
completion, partial results and local retention limits remain distinct.
Source details group each selected relay once across content and relay-list
discovery. They retain context/reply query counts, incomplete outcomes and public
read/write roles. Coverage counters distinguish awaiting a first result, more
pages, retries, exhausted queries, found references and reading limits. They
describe planned coverage and last results, not active subscription counts.
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
Receive-limit shutdown uses application close code `4009`. The native browser
[`WebSocket.close()` contract](https://websockets.spec.whatwg.org/#dom-websocket-close)
allows `1000` or `3000` through `4999`; passing protocol code `1009` throws before
closing the socket. Native-socket browser fixtures cover oversized frames and
message bursts, including subscription-counter cleanup. A mocked WebSocket
alone cannot establish this behavior.

| Resource | Browser | Backend |
| --- | --- | --- |
| Outbound sockets | 12 across reads, wallet and signer; 8 shared read/public-delivery sockets | 32 across lookups, monitors, delivery and receiving wallet |
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
| Browser publication | Two outbox deliveries globally; four transport publication jobs; 12 destinations, 64 KiB per event, eight-second acknowledgement waits | Existing account outbox remains separate |
| Browser publication storage | 32 records and 1 MiB in a separate IndexedDB database; 16 admitted transactions and three-second storage deadlines | No payment-ledger change |
| Reply drafts | Eight parents, 16 KiB UTF-8 text each, separate tab session storage; no automatic eviction | No payment-ledger change |
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

### Browser delivery primitives

`replyPreparation.ts` supplies structural reply templates; its
[context contract](nostr-discussions.md#reply-preparation) requires verified
graph metadata and a matching signed parent. `publicationRoutes.ts` resolves
NIP-65 write relays for the signed event's author and read relays for at most
four tagged recipients. It retains configured public publication fallbacks.
Discovery sources do not become write destinations merely because they returned
metadata. Routing retains observed lists after partial queries, distinguishes
cached lists and reports missing sources and selected-recipient limits. Sources
share read admission and a 12-second deadline. A bounded round-robin selection
keeps at most 12 destinations across the selected groups.

`PublicOutbox` requires a freshly verified signed kind-1 or kind-1111 event and
explicit destinations. Enqueue and listing never publish; `send` is a separate
explicit call. Before sending it commits an inconclusive attempt checkpoint to
`holoboard-public-outbox-v1`, a separate IndexedDB database. A failed write stops
delivery. Each relay outcome is then checkpointed, and accepted outcomes cannot
be downgraded by an older attempt. A tab closing after sending but before saving
an acknowledgement leaves an inconclusive record, preserving the same signed
ID for a deliberate retry. No reload or connection restoration starts delivery.

Native read/modify/write transactions serialize separate tabs. The store admits
32 records and 1 MiB, with at most 16 pending transactions and three-second
open/transaction deadlines. It never evicts earlier publications automatically.
Two outbox deliveries can run globally; duplicate actions in one instance join
the same job. The lower-level transport admits four publications without an
extra queue and reuses the existing eight-socket pool and physical dial limits.
An awaiting publication prevents idle cleanup and read preemption from closing
its shared socket. Completion or cancellation releases only its own waiter.

Delivery interprets [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)
`OK` frames for the exact event ID and boolean result. A positive acknowledgement,
including a positive duplicate response, records relay acceptance. An explicit
negative response records rejection. Timeout or disconnect after handing the
event to the socket remains uncertain; cancellation before sending is distinct.
EOSE is a read outcome and cannot confirm publication. A relay acknowledgement
does not prove global propagation or another client's display.

Retries reuse the stored signed event and omit already accepted destinations.
If acknowledgement checkpointing fails, the saved inconclusive entry remains
available and the error states that the event may already be public. Public
outbox state is independent of expendable read cache, signers, wallets, invoice
sessions and the backend payment ledger. Explicitly forgetting a local receipt
frees capacity but cannot delete a public event or cancel an earlier attempt.
Late acknowledgements cannot recreate a forgotten record. Tests intercept
remote traffic; actual public-network publication remains outside these checks.

### Reply editor

`VITE_ENABLE_REPLY_PUBLICATION=true` exposes Reply controls only when discussions
and Nostr Connect are also enabled. All three flags remain false by default.
The editor consumes the current verified discussion graph; reviewing and signing
both check structural context. Missing or conflicting ancestry blocks preparation.
The selected original item is the parent, including when it is a promoted middle
reply. Promotion membership never supplies root tags or admits the new reply to
the paid board.

Review, Sign reply and Publish reply are separate actions. Signing prepares safe
destinations and saves the exact signed event without publishing. The user then
reviews the signed text, account, relay destinations and discovery limitations
and explicitly consents before sending. Saved replies are inspected without
automatic sends after reload or reconnection. Retry uses the same event ID and
only unresolved destinations. Relay outcomes distinguish acceptance, rejection,
uncertainty and attempts that were not sent. View reply opens the signed event
as a new reading focus instead of changing a historical read's cutoff.

Changing the connected signer clears consent and stops owned routing or delivery.
Closing the editor does the same; a late signature cannot resume a closed flow.
An already sent event can remain public after cancellation. Only the connected
account matching a saved event's public key can authorize its send in the editor.
Drafts are independent of account state and persist in this tab's session storage,
with eight parents and 16 KiB of UTF-8 text each. Storage failures remain visible;
the editor never overwrites malformed storage or evicts another draft. Invoice,
wallet and signer records are separate. Signed replies use the durable outbox,
not the expendable read cache.

Browser acceptance uses isolated fixture keys and intercepted relays for NIP-07
and NIP-46, consent and account changes, promoted middle ancestry, stable-address
NIP-22 comments, missing context, forged signatures, late approval after closing,
draft reload and exact-ID retry after partial acceptance. This establishes local
protocol and UI behavior, not physical Amber compatibility or public propagation.

For the intercepted reply suite, start a fresh Playwright-owned development
server with matching flags:

```sh
cd web
VITE_ENABLE_DISCUSSIONS=true VITE_ENABLE_NOSTR_CONNECT=true \
VITE_ENABLE_REPLY_PUBLICATION=true npm run test:e2e -- tests/replyPublication.spec.ts
```

The disabled configuration must keep Reply controls absent even if one required
flag is enabled alone. The editor loads on demand only behind the combined gate.
Keep restored destinations explicit; retry does not silently substitute newly
advertised relay preferences. No manual or automated release check may publish
real user events without the required authorization.

### Backend account delivery

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
| nostr-tools 2.25.2 | Verification can reuse a symbol cached on an event object. Fresh canonical objects are verified at read and signer ingress. NIP-46 retains successful auth-request bookkeeping, its switchRelays can reopen after close and accepts unchecked destinations, and malformed decrypted RPC responses reject its event callback. Application guards bound sessions, validate changes before subscribing and contain callback failures. Existing Schnorr, encryption and encoding implementations remain in use. |
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
paths request `sign_event:9734` (zap requests) by default. Opting into the reply
editor also requests `sign_event:1` and `sign_event:1111`, using the optional
[NIP-46 permissions](https://github.com/nostr-protocol/nips/blob/master/46.md).
Restored zap-only sessions require explicit reconnection to request the new scope;
restoration cannot silently expand it. This earlier scope limitation does not
establish the cause of reported connection failures. No direct NIP-55 web adapter
is implemented.

### Confirmed signer defects and local fixes

Regression tests first reproduced four application failures: a cached library
verification flag admitted a forged ID/signature, an extension could mutate the
template used for comparison, an old signer handle remained usable after
disconnect, and a signature from an earlier account was accepted after switching.
`connections.ts` now verifies a fresh signed object, keeps a private deep copy of
the requested template and checks connection generation before and after signing.
Disconnect aborts waiting operations immediately. Only one user signing request
can wait for approval at a time; there is no hidden request queue.

Tests against the installed NIP-46 implementation independently confirm retained
auth-request entries after success, unchecked relay switching after close
(including a delayed cleanup exception), and callback rejection for malformed
encrypted RPC data. Holoboard reads `switch_relays` through `sendRequest`, validates
at most four safe destinations before replacing the subscription, and ignores
results from cancelled connections. Unsupported or failed relay switching keeps
the approved relays. `SignerPool` contains unreadable RPC callbacks while the
owning request retains its deadline. No cryptographic implementation is replaced.

A remote session accepts at most 64 user signing requests, then requires explicit
reconnection. This bounds the library's retained request state to at most 67 RPCs
(connection, identity, optional relay update and signing); it is an application
limit, not a NIP requirement. A signing timeout retires the remote session and
its pool, preserving the caller's draft. Initial signer tokens admit at most four
relays. Public metadata discovery never changes signer transport destinations.

Automated checks exercise both NIP-46 initiation methods, wrong pairing secrets,
transport/user key separation, cancellation, stale results, restoration account
changes and signed-payload validation. They use isolated protocol mocks and local
keys. They do not reproduce a physical Amber handoff, establish an Amber version
matrix or explain the user's earlier device failures. That cause remains open.

### Compatibility evidence

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
| Discussion reading | Read-only screen implemented behind `VITE_ENABLE_DISCUSSIONS`, disabled by default. | Original-item focus, paid/unpaid branches expanded by default, exact-parent previews and navigation, grouped source coverage, unresolved context, bounded display pages and local browser navigation checks. |
| Profile reading | Read-only screen implemented and locally verified behind `VITE_ENABLE_PROFILES`, disabled by default. | Shared bounded metadata reads, explicit freshness/source outcomes, verified active campaign membership, discussion return navigation and selected public-relay reads. |
| Signer compatibility | Local signer boundaries hardened and protocol fixtures verified; disabled by default. Physical Amber failures unresolved. | Fresh signature/template checks, connection-generation ownership, both NIP-46 initiation methods, bounded request lifetimes and validated relay changes. Device/environment matrix remains open. |
| User-authored publication | Structural preparation, bounded routing, durable browser outbox and opt-in reply editor implemented; disabled by default. | Signed graph round trips, explicit account/destination consent, durable checkpoints before sending, exact-ID retry, per-relay acknowledgement, cancellation, native IndexedDB reload/failure and separate-tab concurrency. Physical signer and public propagation acceptance remain. |

Keep stages reviewable and independently releasable where their dependencies
allow. Before closing a stage, compare the final diff to its acceptance criteria
and record unresolved limitations. Persist the next concrete action or blocker
so another session can resume. Routine authorized implementation and checks do
not need repeated approval; deployment, public publication and existing-data
migration retain their explicit approval requirements.

Feature development and visual refinement run in separate branches. The
discussion branch owns feature behavior, Nostr relationships and delivery,
state, resource budgets, security and functional acceptance. The visual branch
integrates committed feature checkpoints and owns presentation refinements.
Feature work may add the UI needed for a working feature, using the existing
shared components and visual conventions.

Return visual changes in committed, reviewable stages with their base commit,
scope and verification. Shared components can change in both branches; preserve
their callbacks, feature gates, accessibility and navigation contracts when
integrating. Run checks appropriate to the combined diff, including source-card
position restoration and payment choices when those components are affected.
Keep visual refinements already accepted by the user through subsequent feature
work. The main checkout and its uncommitted work remain independent.

### Current verification and next action

The isolated discussion branch includes the foundation, pinned library migration
and production fixes through `e651ac6`. The main checkout stays independent;
implementation does not enable signer support or deploy any feature.

Frontend acceptance covers 365 unit cases across 43 files, including public
read versus DM relay-list separation and grouped coverage states. Changed-module lint
and production builds with all four features enabled and disabled pass. The
disabled build excludes the reply editor chunk and controls. The combined
enabled browser regression passed 87 scenarios across desktop
Chrome, Android-sized Chrome and iPhone-sized WebKit, covering reading, signer
protocols, payment consent and reply integration. The reply editor separately
exercised 33 distinct project/scenario pairs across its main and focused runs,
covering ancestry, consent, storage failures, account ownership, partial delivery,
relay rejection, cancellation and reload. Nine native outbox scenarios cover
actual IndexedDB transactions, cache isolation, exact-ID retry and separate-tab
concurrency. These suites overlap and their counts must not be added as unique
coverage. All publication/payment fixtures intercept remote traffic and use
isolated keys; they do not spend funds or publish public notes. The final default
configuration passed 21 invoice, hidden-signer, disabled-reply and native-outbox
checks. A further nine browser checks verify that removing each required reply
flag keeps the editor absent. The defaults preserve anonymous payments.

The discussion usability and navigation regression covers 93 distinct browser
project/scenario pairs across discussion, profile and reply-editor suites,
verified across the combined and focused runs. It verifies
automatic expansion, persistent explicit collapse, late parents, parent jumps
across local pages, distinct participant bylines and one source row per relay.
Compact-layout checks also cover short-row height, continuous rails, retained
44-pixel targets, page focus and cross-page branch context. Navigation checks
add source-card geometry in rendered frames for collapsed and expanded bodies,
late ancestors, browser Back/Forward, hidden-board polling updates, short cards
near the document end and cached quote/link previews in the first reader frame.
History writes occur once for saving the source and once for consuming initial
alignment, rather than on every observed content update.
A controlled public-read preview also checked a promoted note with a billboard
and quotation at desktop and phone widths. Its source card matched before entry,
immediately in the reader, after the batch settled and on return. The source
reply action opened the correct editor. No public write frames or page errors
were observed. These checks preserve source geometry; new metadata or media
can still update note content.
Nine default-flag checks keep discussion, profile and reply entry points hidden.
These checks overlap the signer-release evidence above.
The compact-layout unit run passed with `npm test -- --maxWorkers=2`. Keep heavy
signature/graph fixtures separate from simultaneous multi-browser workloads
when diagnosing timing failures before changing deadlines.
Six additional native-WebSocket checks cover receive-limit shutdown across all
three browser projects without replacing the browser socket API.

The application and retained Go dependency packages passed the full race suite.
Regressions include global subscription limits, malformed frames, escaped
subscription IDs, forged authentication IDs, incoming frame order, listener
races, stored-query cancellation and historical ledger decoding. Both backend
binaries build for Linux amd64 with CGO disabled. The backend is unchanged by
the reading and reply UI stages, so that evidence carries forward. The Docker
image has not been built because the local daemon is unavailable. A container
build and the documented release smoke checks remain release requirements.

Controlled public-relay checks loaded kind-1 notes, a middle kind-1111 comment
with its parent/root, a kind-30023 article and an author's profile plus current
campaign membership. Runtime checks cover finite navigation/cancellation workloads
with physical wire counters and retained Chromium heap measurements. Their scope,
commands and measured limits are below. They do not prove complete discovery,
public propagation or universal absence of memory leaks.

Remaining release gates are physical signer compatibility, deliberate public
propagation/interoperability checks and the container/release smoke procedure.
Reported Amber failures still need device reproduction; protocol fixtures do not
establish their cause. Live-wallet behavior remains separate from mocked payment
regressions. Direct NIP-55 support, deletion/moderation discovery and verified
NIP-05 domains are separate features, not implied by the implemented editor.

Continue routine authorized checks and fixes autonomously. Preserve the isolated
branch and false-default flags while another release is prepared from main.
The compact reading layout is implemented and visually reviewed. Before treating
discussion retrieval as finished, review bounded work scheduling against the
large-thread findings below.
The board-note visual redesign is integrated from a stable local checkpoint,
without modifying the independent main checkout or its index. Integration
acceptance rechecked all 365 unit cases and 180 distinct enabled browser
project/scenario pairs across the combined and focused runs. These include the
new board presentation, Billboard originals, rendered-frame geometry, browser
history menu cleanup, profile returns and reply publication fixtures. The
focused 21-check run verifies ordinary and Billboard source geometry, menu
cleanup and waiting-room updates. Another 75 default-release browser checks
cover board notes, hidden reading/signer entry points, anonymous split invoices,
scannable QR codes and promotion-editor focus. Enabled and disabled production
builds pass; the disabled build excludes the reply editor chunk. A controlled
public-read review at desktop and phone widths matched the source card's
position, width and height before entry, immediately after entry, after the
read settled and on return, with no page errors, horizontal overflow or public
write frames. Board-origin
focus cards share the new design; compact reply rows, local author profiles,
unverified address presentation and false-default flags remain intact. Content
expansion has its own state marker, so a Billboard original opened through note
options also survives reader navigation. Popovers escape clipped frames and
remain owned by an enclosing promotion dialog. The next implementation step is
the bounded discussion scheduling review described below, preserving partial
coverage and user-triggered batches. Main pushes and deployment remain separate
gates.
Integration must rerun acceptance against its actual base, without clearing saved
invoices, identities, public outbox entries or the production ledger. Deployment,
public publication, spending, main pushes, external configuration changes and
existing-data migrations still require explicit authorization. Unavailable device
or wallet evidence must remain open without blocking unrelated implementation.

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

The large-thread review used the public kind-1 root
`71548e70da7ec315931758f97acf0006df89cfae4fff8245142b5dcb522dd9a8`
on 2026-10-08. A warmed-cache read found 123 connected replies and 26 unresolved
branches after four batches; these are observations, not the thread's total.
The first 48 rendered replies occupied about 17411 vertical CSS pixels at a
390-pixel viewport width. This identified repeated focus-parent previews, large
card spacing, competing footer actions and disconnected branch lines as reading
problems. The compact layout addresses those findings and bounds desktop width.
For a controlled visual comparison, a later public read supplied 200 verified
events to identical isolated read caches. Both versions rendered the same 48
reply IDs. Their combined row height fell by about 26% at 390 pixels, 19% at
1280 pixels and 29% at 320 pixels. Neither version overflowed horizontally in
those checks; screenshots were inspected at all three widths. These figures
describe this sample, not a universal height reduction or complete discovery.

The same read reached author, target and branch/source-record ceilings before
the lifetime query allowance was exhausted. Branch/source records describe
predicate/relay work, not only visible conversation branches. `Load more` can
continue admitted work but cannot remove hard admission ceilings. Review work
priorities and lazy admission before increasing limits; the current evidence
does not establish a replacement scheduling policy. After correcting native
socket shutdown, a fresh-context, cold-cache read found 77 connected replies and
18 unresolved branches after four batches, with no uncaught page errors. It
still reported partial coverage and hard limits. Network variability and cache
seeding prevent treating the two counts as a before/after completeness measure.

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
intentionally skipped. With the profile reader and delivery waiter support
included, replies expanded and board-origin navigation active, post-GC heap
medians increased from 7,508,824 to 7,723,068 bytes (214,244 bytes, about 0.20 MiB),
within the 2 MiB allowance. This workload measures discussion and navigation
lifetimes; it does not measure repeated profile-screen heap use.
Mock-relay peaks were seven sockets and nine subscriptions. Leaving each view
closed its pending requests; the heap workload reached zero idle sockets and
requests. Cancellation scenarios stayed at at most one idle socket. These
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
Feature-flag rollback must preserve the separate browser publication outbox and
saved payment sessions. Disabling publication hides its entry points without
erasing signed events or evidence of uncertain delivery.

Protocol references: [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md),
[NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md),
[NIP-10](https://github.com/nostr-protocol/nips/blob/master/10.md),
[NIP-22](https://github.com/nostr-protocol/nips/blob/master/22.md),
[NIP-05](https://github.com/nostr-protocol/nips/blob/master/05.md),
[NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md) and
[NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md).
