# Nostr reads and delivery

Holoboard ranks paid notes through its HTTP API. Public profiles, quotes and
receipt discovery use a separate bounded read service. Public-relay results
never change board ranking. Discussion and profile screens can build on these
primitives without adding another relay pool.

## Discovery fund

The optional curator reads public kind 1 notes and kind 1111 comments across
topics and languages, including small projects outside Bitcoin and Nostr.
It combines rotating relay/time-window samples, multilingual
[NIP-50 searches](https://github.com/nostr-protocol/nips/blob/master/50.md), public
references and discovered authors' [NIP-65 write relays](https://github.com/nostr-protocol/nips/blob/master/65.md).
Ordinary time-window reads run independently of text search, so sources that
reject the search filter still contribute candidates. Coverage records search
failures separately from successful ordinary reads.
Reference retrieval can find older notes outside the seed stream windows.
Discovered sources remain read-only and do not change the configured publication
or payment-monitor destinations. The collector uses the existing shared socket
and safe-address budgets.

Each hourly collection has a 15-second deadline, at most four concurrent
queries and twelve selected sources. Candidate storage is limited to 2000 entries
and 8 MiB, with a 64 KiB limit per complete encoded event. Signatures are checked
on owned values, including at admission. Coverage reports complete, failed,
limited and timed-out source queries; it always represents a partial public
sample. Low observed engagement is not proof of low network-wide reach or quality.
Batch selection and author-outbox traversal visit distinct authors before taking
additional notes from the same author. A per-slot seeded hash rotates candidates;
low event IDs and leading proof-of-work zeroes do not receive priority. Issued
batches remain stable on retry. This improves author coverage, not Sybil resistance
or network-wide representativeness.

A local Codex runner evaluates bounded batches through app-server with a ChatGPT
subscription. The backend owns admission, signed originals, expiry and an
independent durable reward journal. Model text cannot supply a payment address,
invoice or wallet command. See the [curator guide](../curator/README.md) and
[HTTP contract](../relay/API.md#operate-the-discovery-curator).

Human review defaults on. In an active fund, selected originals and proposed
reward amounts stay private until a separately authenticated reviewer approves
them. Approval rechecks current policy and starts the seven-day placement;
dry-run approval remains a private review result. The agent credential cannot
approve proposals or disable review. Turning review off affects future picks
and never releases its waiting queue. Turning it on blocks unapproved sends
before their durable send claim; already attempted payments retain lookup-only
recovery. Existing public placements are preserved when their unsent reward is
held for review. The optional loopback operator panel keeps its scoped reviewer
token server-side and provides per-item approval, rejection and the review toggle.

An admitted discovery gets seven days in opted-in Waiting room New. Author
rewards do not enter `PromotedPost.Payments`, totals, Hot or ranking. Later
promotion uses the ordinary anonymous invoice flow and preserves the original
discovery exposure for New and visit badges. Unpaid discoveries expire out of
the active list while their history stays available. No quote or DM is published
just for admission; an actual author zap can produce its provider's public receipt.

The backend prepares a signed [NIP-57 request](https://github.com/nostr-protocol/nips/blob/master/57.md)
for the original event and its author's verified payment profile. Invoice
validation pins the exact amount, mainnet, expiry, request description hash,
recipient and provider before attempting a send. Missing address or unsupported
public zaps leaves the discovery visible with reward unavailable. Temporary
preparation failures retain a bounded retry delay.

The spending connection is separate from the receiving `LightningBackend`.
The durable claim records the invoice, hash, recipient, provider and NWC key
identity before `pay_invoice`. Unknown outcomes use lookup only, including
after restart, pause, removal or pilot expiry. A different wallet connection
cannot resolve that attempt. Matching proof from the original outgoing wallet
confirms payment; an arbitrary public receipt is insufficient evidence that
this backend spent funds. Explicit nonexecuting wallet refusals finish as failed;
timeouts and ambiguous errors remain uncertain and keep their reservation.

The principal budget includes today's confirmed rewards and all unresolved
reservations, including earlier days. Routing fees are recorded separately.
The [NIP-47 pay command](https://github.com/nostr-protocol/nips/blob/master/47.md#pay_invoice)
does not define a universal per-request fee cap; use the wallet's own controls
and a lightly funded dedicated wallet for a total spending boundary. Limits
apply to public keys, not verified people, and do not eliminate Sybil attacks.

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
Discussion pages verify overlapping events again and retain each source's
coverage, but do not rewrite events already admitted to the session and still
retained in its read cache. An expired or evicted body is cached again when received.
This avoids repeated cache verification without trusting an event's ID or the
library's verification flag as proof that an incoming duplicate is valid.
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
respondents. Reply-source priority favors verified public read destinations and
sources that delivered the target, interleaved with configured fallbacks and
hints. The board relay remains a fallback for promoted items; unpaid replies
may live only on public relays. Sources are bounded and each selected relay has its own branch,
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

The planner reserves descendant targets, missing-parent lookups and
predicate/relay coverage records only when selecting a content query to send.
Cached ancestors do not use the network lookup allowance. Author relay lists
are discovered for selected work, so an unsent frontier cannot reserve every
author slot. By default, cache hydration separately scans up to 64 descendant
targets per session and 64 ancestor candidates per pass; all normal event and
graph limits still apply.

The promoted item's own unresolved ancestry has first priority. Other work
rotates through focus replies, other missing ancestors, focus replies and
connected reply descendants, skipping empty classes. Within a class, fewer page
attempts and shallower depth come first, then predicate and source order across
the breadth level. This spreads primary checks over nearby branches before
repeating their alternative predicates and fallback sources. NIP-10 and NIP-22
filters, independent source cursors and exact version pinning are preserved.
The policy is an application scheduling choice, not a Nostr completeness rule.

Snapshots separately expose counts of eligible checks awaiting admission. They
are derived from the bounded graph and do not reserve coverage records or
subscriptions. Counts can change after relay discovery or graph updates; they
are not a total reply count. Hard target, lookup, source-record and lifetime
budgets can still leave work unchecked. `Load more` only continues eligible
work, including retries; discovery retries stop when no new source record can
be admitted. Coverage remains partial at a hard ceiling.

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
Board and expired-note footers link to `/discussion/<nevent>`, embedding the
exact event ID, author and the board relay. Reply links use sources that
actually delivered the admitted event. Both use
[NIP-19](https://github.com/nostr-protocol/nips/blob/master/19.md) pointers;
protocol filters, graph keys, API requests and stored IDs remain hexadecimal.
Legacy hex and `note` routes remain readable. The `from`
parameter preserves a board section and waiting-room sort without allowing an
external redirect. Board navigation seeds the cache only after fresh signature
and ID verification.

`readingRoutes.ts` decodes pointers before opening the existing shared readers.
Embedded author fields are discovery hints, never proof of authorship; exact-ID
lookup and fresh signature verification determine the event and its author.
`nostrPointers.ts` retains at most four safe relay hints, preserving full relay
paths. Its 255-byte ASCII limit per relay matches NIP-19's one-byte TLV length.
The installed `nostr-tools` 2.25.2 encoder writes lengths into a `Uint8Array`
without rejecting larger values; the wrapper omits oversized hints before
encoding. Incoming hints also pass the existing relay policy and resource
admission. Reader URLs remain capped at 4096 characters, with at most two
reader return levels. An overlong generated return is omitted, preserving the
pointer and its hints. Existing incoming pointers are retained for browser
history and position restoration; their hints are filtered before use.

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

Board section links use the same history navigation, including when reader
features are disabled. The two public lists retain their most recent campaign
snapshot, page count and text disclosures in memory and refresh when remounted.
The waiting-room URL remains the source of sort selection, including explicit
New links and browser history. Leaving and returning starts a new waiting-room
visit; changing its sort keeps the current visit baseline. These list snapshots
do not contain account credentials, payment drafts or invoice records.

`useReadingPosition` owns history restoration across board, discussion and
profile views. It applies before paint, then observes delayed content for at most
35 seconds, stopping on user interaction or navigation. Bounded spacing above
the anchor and below the surface allows alignment near document edges. The
retained board restores the same event offset even when polling inserts earlier
rows. If the event disappears, the saved scroll value is the fallback. Browser
Back/Forward and explicit return links use the same restoration. During
restoration, `useReadingStability` yields to the saved navigation anchor. During
ordinary scrolling it tracks one visible content block on the active board,
discussion or profile surface. Surface resize and DOM observers compensate for
earlier asynchronous layout changes, including media, quotes, link previews and
graph updates. Intentional scrolling updates the baseline; pointer, click,
keyboard and viewport changes yield before selecting a new anchor. Modal body
locking pauses this adjustment. Both hooks disable native scroll anchoring only
while they own the active surface, avoiding competing adjustments (see the
[CSS Scroll Anchoring draft](https://drafts.csswg.org/css-scroll-anchoring/)).
Keep the focus list's `flow-root` formatting context (or an equivalent layout
that prevents parent/child margin collapse). The anchor spacer must contribute
its full height; collapsed margins invalidate the restoration calculation.
Surface padding and note-anchor margins must not transition. The global reduced
motion rule shortens transition duration on every element; without an explicit
`transition-property: none`, even these previously static spacers can interpolate
for a frame and invalidate the measured offset.
Exercise reading with reply publication disabled as well as enabled: the extra
reply action can conceal a short mobile Billboard's alignment regression.
Known author metadata, cached quote/link previews and overflow measurements
are available before the first paint of a remounted card. Newly arriving metadata
or media can still change its height during a read.

Explicit branch collapse, local pages and context expansion survive reloads through
session storage for at most eight discussions, separately from payment and
identity storage. New and late-parent branches open automatically unless an
ancestor was explicitly collapsed. Earlier ancestor context starts collapsed
behind a counted disclosure. Selecting an ancestor through a parent link opens
it automatically and focuses the exact note. Each resolved reply names its actual parent
author. Direct replies to the reading focus omit its repeated text preview;
nested replies retain a one-line cached preview with shortened references and
media labels. Selecting that context reveals and
focuses the parent, including on an earlier local page or in hidden ancestor
context. Parents beyond the projection use an exact discussion link instead.
The `Thread` action (accessible name `Open thread`) makes the selected note the
reading focus without changing its protocol ancestry or promotion status.
Graph updates share the continuous reading anchor instead of applying a second
scroll correction. Preservation depends on the anchored content remaining
rendered and enough document space for the requested offset. Removal of the
anchor and browser scroll clamping are not covered by a universal no-jump
guarantee. `web/tests/readingStability.spec.ts` holds earlier image, quote and
link responses until after scrolling, then checks the visible note's offset.

Replies use compact rows with continuous branch rails and a maximum four visual
indentation levels. Exact parent links retain the full relationship when depth
exceeds that display cap. The reading focus keeps its notched frame; promoted
replies use a thin gold marker and inline label without changing ordering.
The reply column and direct-URL focus are at most 768 CSS pixels wide; a
board-origin focus retains the board width. Compact rows place the author and
parent navigation beside each other in one header. Branch collapse uses a
stepped chevron and count in the subdued footer beside body expansion,
navigation and secondary timestamps. Controls keep
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

`web/tests/readingPointers.spec.ts` exercises cold `nevent` and `nprofile` reads
available only on an embedded hint, an incorrect event-author hint, unsafe
destinations, observed-source sharing and exact return navigation. Run it with
both reading flags enabled. Route unit tests also retain legacy URLs and check
pointer types, checksums, TLV sizes and nested URL budgets. The read-only PWA
acceptance uses these pointers across update and code rollback while preserving
the original prepared invoice. On machines with limited resources, run native
builds, full unit suites and browser suites sequentially; use `--workers=1` for
browser checks before treating a delayed fixture as a product regression.

## Profile screen

Set `VITE_ENABLE_PROFILES=true` to enable `/profile/<nprofile>` and local
author/mention links. The flag is false by default and independent of
`VITE_ENABLE_DISCUSSIONS` and signer support. Disabled profiles retain the
existing external profile links. Both screens can run without an account.
Legacy hex and `npub` routes still work. Profile pointers carry supplied safe
hints, observed public note sources and cached, verified NIP-65 write relays.
Cached relay lists contribute write entries only; NIP-65 read entries and
NIP-17 DM lists are not imported as profile hints. External reading links also use
`nevent` and `nprofile`, both [supported by njump](https://github.com/fiatjaf/njump).
Copying a public key continues to use `npub`.

`profileReads.ts` shares metadata work between bylines and profile views.
Cached kind-0 data renders immediately; opening the screen checks configured
sources and the author's discovered NIP-65 write relays. Leaving closes the
view's handle, and the last close cancels work, including relay discovery and
queued admission. A returning view joins cancelled work before starting a fresh
read. React StrictMode startup uses the same cancellable microtask pattern as
discussions. Empty checked sources, failed sources, malformed latest metadata
and cached data remain distinct. A cached read alone never extends its TTL.

Bylines consume verified metadata updates as they arrive, without waiting for
the remaining sources to finish. Their handles close after the bounded read or
on unmount; cached metadata avoids a new read. This improves display latency
without changing shared admission or treating incomplete relay reads as absence.

Profile ordering follows [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md):
newest timestamp, then lowest ID. Fields follow kind-0 metadata and
[NIP-24](https://github.com/nostr-protocol/nips/blob/master/24.md).
The screen shows a name, biography, safe website, public key and avatar, with an
optional bounded banner. Lightning contact fields follow
[LUD-16](https://github.com/lnurl/luds/blob/luds/16.md): show `lud16`, or a valid
Bech32 `lud06` LNURL when no address is available, with a copy action. Displaying
or copying these fields does not request payment information or send funds.
Website and image URLs reject unsupported schemes and credentials; React text
nodes keep signed markup inert. No automatic biography embeds, follower counts,
profile editing or public event publication are added.

The open profile separately checks its declared
[NIP-05](https://github.com/nostr-protocol/nips/blob/master/05.md) address using
HTTPS `/.well-known/nostr.json?name=<local-part>`. A cyan check appears only when
the response's exact `names` mapping matches this public key. Checking,
key mismatch, invalid address and unavailable domain are distinct states;
network, CORS, redirect and malformed-response failures are inconclusive and
allow an explicit retry. This verifies a domain-to-key mapping, not a person's
identity. Root `_@domain` claims display as `domain`.

Each check uses shared read admission, an eight-second deadline including queue
time, a 64 KiB streamed-response limit, no credentials or referrer and no
redirects. Leaving the profile or replacing its claim cancels the check; a late
result cannot verify a newer claim. Results stay within the mounted profile,
without a persistent verification cache or background byline checks. Domain
responses do not add relay destinations.

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

### Header account entry

The header's primary framed action and main editor are named Add to board
independently of post creation availability. Phones shorten the action to Add
while retaining its full accessible name. Wallet and the optional account entry
use quiet 44-pixel controls. Sign in and the connected avatar require
`VITE_ENABLE_NOSTR_CONNECT`, which also gates automatic signer restoration.
Connected account metadata comes from the same verified profile reader used by
bylines, with Account and a generated avatar as fallbacks. Connected accounts
show only the avatar at every width, with their name in the menu and accessible
trigger label. Phones use a stepped arrow entering a doorway for Sign in.
Account connection details and disconnect are available through an anchored
keyboard-accessible menu. Its
Your profile action additionally requires `VITE_ENABLE_PROFILES` and preserves
local reader return paths. Disconnecting the account leaves the payment wallet
connected. Closing connection settings restores focus to the current account
trigger, including after Sign in becomes an avatar. Successful header sign-in
automatically closes its panel; pending approval and connection errors keep it
open. Header NWC setup also closes after success and returns focus to the wallet
icon. Explicitly opened connected account settings and wallet panels stay open;
disconnecting there starts setup again, which closes after a successful reconnect.

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
| Discussion session work | 64 network descendant targets, 64 network ancestor lookups, 256 admitted branch/source records, 8 relays per predicate, 8 author discoveries; 128 queries over its lifetime, 16 per batch, 16 page attempts per descendant branch | Not applicable |
| Discussion admission | 1024 observed events, 4 MiB of received serialized events, 256 KiB per event; 30-second batches and 4-second queries | Not applicable |
| Profile metadata | 64 active/closing author reads, 256 view handles; 64 KiB per signed profile, nine fields of at most 2048 characters each; 12-second reads, 4-second discovery and 6-second metadata queries | Not applicable |
| Profile NIP-05 check | One claim per mounted profile; shared admission of 4 active reads and 64 queued, eight-second deadline including queue time, 64 KiB response | Direct browser HTTPS read, no proxy or backend route |
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
field types are discarded. Signed metadata alone never verifies a NIP-05 claim;
the profile badge requires a separate successful domain check.

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

## Paid root posts

The opt-in Add to board flow creates kind 1 roots with canonical `nostr:`
references and distinct `q` tags for quotes. It never borrows reply ancestry from
the quoted source. Source authors come from verified events, following
[NIP-18](https://github.com/nostr-protocol/nips/blob/master/18.md#quote-reposts).
A standalone source selects the original until the author explicitly adds a
comment. The existing legacy reference parser remains available to API callers;
the new shared field uses a stricter whole-input classifier.

Private signed roots stay in invoice snapshots, outside public preview caches,
read caches and the browser PublicOutbox. Board settlement atomically creates
credit and the original publication record. The durable publisher shares the
bounded destination set with the account quote and requires original acceptance
before each quote send. Root routing uses the author's write relays and verified
quote authors' read relays. Operator removal serializes with publisher sends and
cancels remaining root/quote work. Already transmitted frames remain public.
Disabling creation admission or the frontend does not disable settlement or the
publisher; rollback must retain a backend understanding these records.

Guest posts use fresh in-memory keys with optional NIP-19 export. The author signs
its own NIP-32 attribution label in `space.holoboard.attribution`. **Anonymous** is
shown consistently while preserving the actual pubkey. No payment-side flag
changes authorship. The label gives no guarantee about metadata, payment privacy
or external clients. Normal author support retains separate missing-address and
unavailable-profile states. Existing Nostr signers retain exact-event signature
validation. Creating posts and recovering issued invoices do not require an
account service.

Email/password accounts are deferred to a separate change. The intended direction
is Holoboard-owned sign-in and recovery forms with established authentication
components. Keep these flows within Holoboard's interface. A reusable account API
and signer interface should support web and native mobile integration independently
of Khatru. The proposed first-version contract recommends a TypeScript server
library with a standalone service wrapper and a separate client SDK. This adds
a Node service beside Holoboard's Go backend; the embedded Go alternative would
avoid that process. Components remain recommendations pending implementation
review and integration checks. Dependencies must preserve the required UI,
identity recovery and session behavior. Authentication and author-key custody
need separate designs; resetting a password must retain the same author key.
Database and encryption-key backups
must support restoring that identity after a server failure. This release does
not implement custodial accounts. Account work must not block guest posts,
existing Nostr signers or anonymous invoice payments.

The [native account contract](accounts-design.md) describes the proposed API,
web/native sessions, signing scope, dependency fit, deployment and recovery
acceptance. Its direct API initially serves operator-owned clients. Hosting
NIP-46 for third-party clients is separate scope. These choices remain proposed
until accepted and verified.

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

The reusable `NoteEditor` owns text and attachment editing independently of the
reply graph. The Reply shell supplies verified parent context and the existing
review, signature and public-delivery steps. Desktop uses a wider dialog; phones
use the full available visual viewport with a fixed action footer. Write and
Preview retain the same draft. Unicode emoji and GIF URLs insert at the caret;
Ctrl/Cmd+Enter reviews the draft and never signs or publishes it. Unsigned
previews skip automatic quote and destination embeds.

File selection, paste and drag/drop stage local files without uploading.
Each explicit upload uses the selected server only, with no automatic fallback,
mirroring, payment or Nostr publication. Primal and nostr.build use
[Blossom BUD-02](https://github.com/hzrd149/blossom/blob/master/buds/02.md);
custom public HTTPS Blossom origins are supported. nostrcheck.me uses its
advertised [NIP-96](https://github.com/nostr-protocol/nips/blob/master/96.md)
endpoint, constrained to the built-in expected API. NIP-96 is deprecated in
favor of Blossom; the compatibility adapter does not define the editor model.
One upload is admitted globally, with eight attachments per draft, 20 MiB per
file and 40 MiB of selected local files. HTTP transfer has a 120-second deadline,
the full operation 150 seconds, and JSON responses are bounded to 64 KiB.

[BUD-11](https://github.com/hzrd149/blossom/blob/master/buds/11.md) authorization
uses kind 24242, the exact SHA-256 file hash, server domain and a five-minute
expiration. NIP-96 uses kind 27235 HTTP authorization for the discovered URL,
POST method and original file hash. Queued NIP-96 uploads use a separate GET
authorization scoped to the exact processing URL on the advertised API origin.
At most eight status reads, spaced two seconds apart, request fresh GET signatures
within the existing operation deadline. nostrcheck.me rejects reuse of a token
with HTTP 401, so each read may require signer approval. Approval taking 45 seconds
or more stops the read before sending its stale token. Redirects, changed
processing URLs, payment requests and cross-origin processing stop the flow.
Only completed metadata enters the draft; a processing timeout preserves the
uncertain upload outcome without repeating its file transfer.
These events go only to the chosen HTTP
server. New opt-in remote sessions request these two upload kinds; restored
sessions without saved media permissions require explicit reconnection and
cannot silently gain them. Closing or changing accounts stops upload ownership;
a late signature cannot send a file or edit a closed draft. Cancelling a request
does not establish whether the server received its bytes. Paid-server responses
stop the flow without issuing or paying an invoice.

Primal currently requires padded standard Base64 authorization, whereas current
BUD-11 requires unpadded Base64url. An explicit compatibility rule applies only
to `https://blossom.primal.net`; other Blossom origins keep BUD-11 encoding.
This matches the provider's [decoder implementation](https://github.com/PrimalHQ/primal-blossom-server/blob/main/src/lib.rs)
and a controlled read comparison: the same signed list token returned HTTP 400
with Base64url and HTTP 200 with standard Base64. Its error response omitted
CORS headers, hiding the reason behind a browser network error. A browser HEAD
check accepted the compatible encoding. No encoding fallback repeats an upload.

Blossom descriptors must match the local file hash and size. NIP-96 descriptors
must match its original hash; transformed file metadata remains distinct. This
validates the returned descriptor, not an independently retrieved hosted file.
Only valid HTTPS URLs enter the text. Current attachment descriptions and hashes
become [NIP-92](https://github.com/nostr-protocol/nips/blob/master/92.md) `imeta`
tags only while their URL remains in the draft. Parent media tags are not
inherited. Uploaded metadata uses a separate bounded session-storage key so
existing text drafts remain readable by earlier builds. Unuploaded local files
are not restored after closing. Removing an attachment does not delete its
hosted file; public upload availability and retention depend on the provider.

[gifs.nostr.build](https://gifs.nostr.build/developers) provides browser search
without an API key for registered origins and loopback development. The
documented production-origin registration costs 1000 sats once; implementation
does not register an origin or spend funds. Set `VITE_ENABLE_GIF_SEARCH=true`
only after registering the release origin. With search disabled or unavailable,
the picker still accepts direct GIF links. Search starts on an explicit action,
requests at most 24 safe results, bounds JSON to 128 KiB and uses a 12-second
deadline. Closing the picker cancels its request. Results use static thumbnails
and display the required nostr.build attribution. Live read-only research
verified the API shape and loopback CORS; intercepted browser upload tests do
not establish production upload policies or physical signer compatibility.

Upload fixtures compare authorization hashes with a known local file. Chromium
also checks the intercepted binary body. The current Playwright WebKit inspector
can omit XHR `File` bodies, so its upload cases do not independently verify the
transferred bytes. Keep that tooling limitation distinct from server acceptance.

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

On 2026-10-10, ptrio42 reported successful sign-in with Amber and a browser
extension after the fixes. This is actual-environment evidence for basic login;
the pairing method, device, browser and signer versions have not yet been
recorded. Signing, public reply delivery and uploads were not reported as tested.
Current code exposes a browser extension and NIP-46 remote flows,
including `nostrconnect://` and pasted `bunker://` strings. Both remote connection
paths request `sign_event:9734` (zap requests) by default. Opting into the reply
editor also requests `sign_event:1` and `sign_event:1111`, plus upload
authorization kinds `sign_event:24242` and `sign_event:27235`, using the optional
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

Run signature-heavy unit suites separately from browser and heap checks. If a
pagination fixture exceeds its wall-clock deadline, measure signing,
verification and planning separately before changing a resource limit or test
allowance. Passing mocks do not replace the transport and browser checks.

When running UI fixtures against a production preview, build with the same
API/relay origins and feature flags as their test configuration. Runtime preview
variables do not change a previously built bundle; a fixture that blocks the
bundle's API origin fails before it exercises discussion behavior.

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
| Foundation and relation engine | Deployed on 2026-10-15. | Shared transport/cache/discovery and relation-contract regressions, full Go race suite, frontend unit/build checks and browser coverage. |
| Go library migration | Deployed on 2026-10-15 with the existing volume and identity. | Pinned revision, reproducible patch, historical-format fixture including unknown fields, Go race and Linux/container checks; production API, stored-event WebSocket and public board retention checks. Real settlement and public DM routing remain unverified. |
| Discussion retrieval | Deployed and consumed by production discussions. | Bounded discovery and missing-parent retrieval, cancellation, pagination and honest per-relay coverage, feeding the shared relation engine. |
| Discussion reading | Enabled by the Pages production profile; ordinary build defaults remain disabled. | Original-item focus, paid/unpaid branches expanded by default, exact-parent previews and navigation, grouped source coverage, unresolved context, bounded display pages and browser navigation checks. |
| Profile reading | Enabled by the Pages production profile; ordinary build defaults remain disabled. | Shared bounded metadata reads, explicit freshness/source outcomes, verified active campaign membership, discussion return navigation and selected public-relay reads. |
| Signer compatibility | Enabled in production with explicitly accepted validation gaps. ptrio42 reports successful actual Amber and browser-extension login. | Fresh signature/template checks, connection-generation ownership, both NIP-46 initiation methods, bounded request lifetimes and validated relay changes. Broader device and publishing checks remain open. |
| User-authored publication | Reply editor and durable browser outbox enabled in production with explicitly accepted validation gaps. | Signed graph round trips, explicit consent, exact-ID recovery and per-relay outcomes; controlled public editor delivery and provider reads. Physical signer publishing and remaining live recovery acceptance remain open. |

The 2026-10-15 release uses frontend revision `f0b4485` and backend image digest
`sha256:7b88e0d993700b0ec650800d83703258d8a916711ebf5bd63996e9022ca72047`.
The backend was deployed and checked before the frontend push. Checks retained
all 42 public board notes and their cumulative amounts, the same relay key and
one machine on the existing volume. Pages reported success for the exact source
revision, which is also exposed by the production HTML's `holoboard-revision` tag.
The four production feature flags are versioned in `web/production-features.json`.
Production browser checks passed board, discussion, profile and unsigned Reply
reading, plus fresh PWA activation/reload and the phone sign-in screen. Writes
remained blocked. Four Cloudflare `/cdn-cgi/rum` telemetry attempts were recorded
separately from application writes; no application write or page exception was
observed. These browser checks do not establish an installed physical device's
update behavior or a real signer publication.
The release was explicitly authorized with the remaining real-environment
checks below still open. Authorization does not mark those checks passed or
authorize test payments, public test messages or additional uploads.

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
shared components and the maintained
[frontend visual conventions](../web/README.md#visual-conventions).

Return visual changes in committed, reviewable stages with their base commit,
scope and verification. Shared components can change in both branches; preserve
their callbacks, feature gates, accessibility and navigation contracts when
integrating. Run checks appropriate to the combined diff, including source-card
position restoration and payment choices when those components are affected.
Keep visual refinements already accepted by the user through subsequent feature
work. The main checkout and its uncommitted work remain independent.

### Current verification and next action

The isolated discussion branch includes the foundation, pinned library migration,
compact note integration and release checks through `7edfe32`, with the reader
alignment fix described above. The main checkout stays independent;
implementation does not enable signer support or deploy any feature.

The final local review rechecked all 375 unit cases, full frontend lint, the
application and retained dependency packages with Go's race detector, and the
vendored source reconstruction (92 retained files). Read-only acceptance must
also run with both signer and reply publication disabled. A collapsed mobile
Billboard exposed a 34-pixel initial alignment error in that configuration;
preventing spacer transitions and focus-list margin collapse removed it in
repeated strict geometry checks. Final read-only browser acceptance passed 75
project/scenario pairs, with six configuration-specific cases intentionally
skipped and no failures. All 12 ordinary/Billboard geometry combinations stayed
below one pixel of measured deviation across the three browser projects.
The final default configuration separately passed 15 browser checks for hidden
discussion/profile/reply/signer entry points and anonymous split invoices.
Six enabled checks reverified NIP-07 and NIP-46 signing with explicit destination
consent on the three browser projects, using intercepted publication fixtures.
Clean native production builds passed for default, read-only and fully enabled
configurations. Default and read-only outputs contain neither a reply-editor
chunk nor its service-worker precache reference; the enabled output contains both.
The broad-tree browser scenario allows up to
180 seconds for several explicit continuation batches; per-batch waits and the
128-operation and 48-rendered-reply assertions remain unchanged. This extends
only the test's total deadline, not application resource limits.

Frontend acceptance covers 375 unit cases across 43 files, including lazy
network admission, breadth-level scheduling, exact/address target accounting,
hard-ceiling continuation, public read versus DM relay-list separation and
grouped coverage states. Changed-module lint
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
checks. The scheduling stage separately rechecked 15 default-release browser
cases covering hidden discussion/profile/reply entry points and anonymous
single/split invoices on all three projects. A further nine browser checks
verify that removing each required reply
flag keeps the editor absent. The defaults preserve anonymous payments.

The discussion usability and navigation regression covers 105 distinct browser
project/scenario pairs across discussion, profile and reply-editor suites,
verified by a complete production-preview run. Nine default-only cases are
intentionally skipped in that enabled run. After final source-priority and
coverage changes, 15 focused production-preview checks reverified broad
parent-only trees and ordinary/Billboard source geometry in all three browser
projects. These repeat existing scenarios rather than adding unique coverage.
It verifies
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
the reading and reply UI stages, so that evidence carries forward. Both Docker
backend targets and the disabled-feature frontend image build successfully.
The isolated container acceptance passed actual Compose startup, nginx syntax
and health, proxied board/campaign/waiting APIs, private-preview rejection,
verified stored-event WebSocket reads with EOSE and CLOSE, anonymous mock-invoice
creation and browser access to visibility-only boosts. SIGTERM completed and
restart preserved the identity, original note and pending invoice. Signer,
discussion and reply controls stayed hidden, with no reply-editor chunk.
Compose forwards all opt-in feature arguments; the additional enabled container
build is available with `--with-features` and was not run in this acceptance.
Native enabled builds retain their separate evidence above. The smoke uses an
isolated backend network and guards browser requests; four external browser
attempts were blocked. Image/dependency downloads during building are separate
from runtime isolation. No public Nostr write or live-wallet payment is part of
this check. Disposable containers, networks, volume and image tags were removed.

Controlled public-relay checks loaded kind-1 notes, a middle kind-1111 comment
with its parent/root, a kind-30023 article and an author's profile plus current
campaign membership. Runtime checks cover finite navigation/cancellation workloads
with physical wire counters and retained Chromium heap measurements. Their scope,
commands and measured limits are below. They do not prove complete discovery,
public propagation or universal absence of memory leaks.

Remaining release gates are broader signer/device acceptance, deliberate public
propagation/interoperability checks and deployment-origin/installed-PWA checks.
Basic Amber and browser-extension login has actual user-reported confirmation;
signing, rejection/recovery and other pairing methods retain their own acceptance.
Live-wallet behavior remains separate from mocked payment
regressions. Direct NIP-55 support and deletion/moderation discovery remain
separate features. NIP-05 verification belongs to the opt-in profile reader,
not the implemented reply editor.

Continue routine authorized checks and fixes autonomously. Preserve the isolated
branch and false-default flags while another release is prepared from main.
The compact reading layout is implemented and visually reviewed. Bounded
discussion scheduling now admits network work lazily; its controlled regression
acceptance is recorded below. Hard limits still prevent a completeness claim.
The note, header, profile, payment and adaptive-content stages through visual
checkpoint `838ed85` are integrated in the isolated discussion branch, compared
with feature base `1cbb8ac`. The independent main checkout and its index remain
unchanged. Board-origin focus cards share the accepted note presentation and
preserve their geometry and exact return position, including Billboard originals,
local text expansion and independently expanded quotes.

Reading history retains at most 64 validated text keys (`main` or an exact quoted
event ID) alongside Billboard disclosure state. A separate bounded presentation
cache preserves gallery geometry without changing Nostr admission, identity or
payment storage. Shared dialogs give keyboard ownership to the top visible modal,
so closing an image keeps its editor. Verified byline metadata can appear while
other sources remain pending; incomplete reads cannot guarantee every profile.

Combined acceptance passes 426 unit cases, changed-module lint and default,
read-only and fully enabled production-mode builds. Reader, note, profile,
pointer, header, payment, wallet, board-update, reply and public-outbox fixtures
pass across desktop Chrome, Android Chrome and iPhone-sized WebKit. PWA checks
preserve anonymous invoices, wallet links, clipboard and decoded QR payloads
through a legacy-client update, a read-only update and code rollback. Production
bundle fixtures check retained memory, socket/request limits and cancellation.
Expected feature-gate and browser-capability skips remain explicit in reports.
Local signers, payments and publication use fixtures; this is not live settlement
or independent-client delivery evidence.
Selected invoice QR codes are revealed within the modal's scroll area, preserving
their 220px size above the fixed controls on normal phone viewports. Narrow-phone
fixtures check the entire QR bounds and decode its image payload.

Incremental read snapshots clone event tags. Derive text and attachment tokens
from tag values so unchanged comments retain their layout measurements during
graph updates. The large-tree regression bounds measurements per visible text
block and fails against the uncorrected visual import. New UI tests must decode
canonical `nevent`/`nprofile` links and verify the exact event or author, rather
than requiring the older hexadecimal or `note` presentation.

Integration preserves saved invoices, identities, public outbox records and
default-disabled signer/reply flags. Deployment, public publication, spending,
main pushes, external configuration changes and existing-data migrations retain
their explicit authorization requirements. Physical signers, deliberate public
delivery and real DM/wallet interoperability remain gates for their own releases.
Unavailable device or wallet evidence does not block unrelated implementation.

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
continue eligible work but cannot remove hard admission ceilings. This led to
lazy admission and breadth-level primary checks without increasing the limits.
Controlled regressions establish the scheduling behavior; they do not prove
complete public-thread retrieval. After correcting native
socket shutdown, a fresh-context, cold-cache read found 77 connected replies and
18 unresolved branches after four batches, with no uncaught page errors. It
still reported partial coverage and hard limits. Network variability and cache
seeding prevent treating the two counts as a before/after completeness measure.

Controlled scheduling regressions use 70 direct replies with 70 parent-only
grandchildren, so a root query alone cannot discover the grandchildren. The
previous planner found 21 grandchildren in this fixture; the new acceptance
requires at least 60 within the unchanged 128-query lifetime allowance. A
separate cached-frontier regression reproduced 256 reserved source records after
one network operation in the previous planner. It now requires one admitted record,
only the focus author's routing state and no premature target/author/source
limit. Cached ancestry fits within two actual missing-parent lookups. The broad fixture also runs with all replies
on a public relay rather than the board. A one-query fixture requires selecting
the known public read destination first. Additional
checks preserve the promoted focus's context priority, shared accounting for an
addressable item's predicates, retry cursors and terminal hard-ceiling behavior.
These fixtures establish the reported bugs and scheduling behavior, not a
public-thread completeness rate.

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

Final scheduling acceptance repeated the production resource suite on
2026-10-08: all four applicable cases passed, with mobile heap measurements
intentionally excluded. Across 24 desktop cycles, the retained-heap medians were
7,621,996 and 7,802,820 bytes, a 180,824-byte increase within the 2 MiB allowance.
Wire peaks were seven sockets and nine REQs. Eight cancellation cycles per
browser project left zero active REQs and at most one idle socket, with no page
errors or write frames. An earlier WebKit run exceeded its 20-second cached-reply
startup assertion; its unchanged isolated repeat and the complete final suite
passed. That initial timing failure does not establish a planner defect or
physical-device performance.

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

Release readiness is scoped to an artifact and its enabled features. Browser
feature flags do not disable the backend's migrated Nostr transport, Khatru,
DM monitor, receiving-wallet connection or account publisher. A disabled-feature
frontend is therefore not evidence that the migrated backend can skip its own
interoperability checks.

| Release scope | Required evidence before enabling or deploying |
| --- | --- |
| Frontend with all new features disabled | Combined-base board, promotion and anonymous-payment regressions; production build without the reply editor chunk; target API route checks and PWA update/rollback checks. No signer/device acceptance is implied. |
| Read-only discussions and profiles | Reading flags enabled with signer and reply flags disabled; combined-base relation, cancellation, navigation and profile acceptance; target-origin checks. Physical signer acceptance is not a dependency of reading. |
| Signer support | Record the environments for the successful Amber and browser-extension logins and complete the supported device/method matrix below, including a second independent remote signer. Connection approval alone does not authorize publication or payment. |
| User-authored replies | Signer acceptance plus explicit destination/account consent, durable exact-ID recovery and independently observed public reply relationships. |
| Migrated backend | Combined-base Go race and historical-ledger compatibility checks, container startup/restart/shutdown evidence, controlled DM/payment/account-publication interoperability, and preservation of the production identity, volume and current ledger. Frontend flags cannot waive this gate. |

Frontend and backend releases may be staged separately when the target backend
already serves the API routes the selected frontend needs. Check those routes
on the intended origin rather than inferring compatibility from a local build.
An enabled container release also needs the enabled-image smoke; the previous
disabled-image smoke and native enabled build do not establish that result.
After importing another visual checkpoint or changing the release base, rerun
the affected combined acceptance before treating these results as current.

### Read-only frontend release

Prepare this release independently of the Go/Khatru migration. Keep the existing
production backend, identity and ledger when its contract passes. Reader screens
consume the existing board/campaign APIs and public Nostr reads; they add no
required discussion or profile HTTP endpoint. Enable only these build flags:

| Setting | Reader artifact |
| --- | --- |
| `VITE_ENABLE_DISCUSSIONS` | `true` |
| `VITE_ENABLE_PROFILES` | `true` |
| `VITE_ENABLE_NOSTR_CONNECT` | `false` |
| `VITE_ENABLE_REPLY_PUBLICATION` | `false` |
| `VITE_RELAY_URL` | `wss://relay.holoboard.space` |
| `VITE_API_URL` | `https://relay.holoboard.space` |
| `VITE_SATS_ENDPOINT` | `https://relay.holoboard.space/api/board` |

Use the existing public board identity and configured public read relays, never
preview identity or loopback overrides. Keep repository defaults disabled;
these are explicit candidate build settings. The production output must exclude
the reply-editor chunk and its worker precache reference. Signer restoration and
public-zap creation stay disabled; ordinary anonymous invoice actions remain.

Run `HOLOBOARD_LIVE_READS=1 npm run test:reader-release` from `web/` before
selecting the artifact. It bounds HTTP bytes and deadlines, rejects missing
routes/non-JSON responses, checks browser CORS and verifies fresh campaign and
expired-note signatures. A documented link-preview upstream failure can be
valid; a missing handler cannot. With a loopback `HOLOBOARD_PREVIEW_ORIGIN`, it
also exercises the compiled frontend against real public sources, blocking
HTTP writes and Nostr write/authentication frames. This checks compatibility
at the observation time, not network-wide reply completeness or live payment
settlement. Reports omit response bodies and wallet data.

Candidate acceptance was refreshed after the reply editor, visual integration,
discussion cache optimization and worker-update fix. Native unit acceptance
passed 445 tests. Browser acceptance on desktop Chrome, Android-sized Chrome and
iPhone-sized WebKit includes:

| Local stage | Passed | Skipped |
| --- | --- | --- |
| Default feature gates | 18 | 0 |
| Discussion, profile and note navigation | 248 | 7 |
| Enabled account header | 12 | 0 |
| Payments, wallet and board updates | 408 | 3 |
| Reply publication and durable outbox fixtures | 72 | 3 |
| Legacy invoice, reader rollback and enabled Reply PWA | 9 | 0 |

The skips cover disabled-feature cases exercised by the default stage and one
WebKit NIP-05 redirect-interception limitation covered by native and Chromium
checks. No passing stage needed automatic retries. Three native build variants
(default, readers and enabled signer/reply) passed. The verification runner's
10 regression tests passed separately; use Python `-B` and do not create source
outputs while a source-preservation check is active.

After the media compatibility corrections, all 453 native unit tests, changed
TypeScript lint and default/enabled builds passed. The affected upload paths
passed 18 browser cases across desktop Chrome, Android Chrome and phone WebKit.
Three additional queued-processing checks passed after making GET tokens
single-use. These targeted reruns cover the changed upload behavior; they do
not represent another full payment, reader or PWA acceptance run.

The timestamp retrieval regression with 513 signed matching replies now passes
with its original 60-second deadline. Overlapping pages had repeatedly written
already-retained verified bodies to the cache. The fix preserves fresh signature
checks, relay provenance and pagination coverage, and restores a body after cache
expiry or eviction. Read budgets and incompleteness reporting are unchanged.

Worker acceptance exposed a separate confirmed defect: Workbox removed an old
lazy QR module during activation, and an already-open tab received HTTP 404 when
opening its saved invoice. The bounded asset archive described in
[the frontend reference](../web/README.md#check-changes) fixes this update path.
The PWA scenarios preserve the original invoice, wallet link, clipboard/decoded
QR, status checks and unsigned Reply draft without issuing another invoice or
publishing. They use Git-built baselines `56439d7` and `7cfd9ea`, which are not
identified as the currently deployed Pages artifact. Stopping both local HTTP
servers checks cached-shell startup, not physical-device offline behavior.
Expected WebKit native ledger-fetch failures are paired with actual requests
during that controlled outage; unrelated errors still fail acceptance.

Production-configuration reader and enabled signer/reply variants passed eight
bounded API-route checks, browser CORS, fresh note signatures, and board,
discussion and profile reads against the unchanged public backend. The enabled
variant also opens and previews an unsigned Reply draft. HTTP writes and Nostr
publication/authentication frames remain blocked in this smoke. Keep a source
revision, explicit configuration and file-hash record with the selected artifact.
For the enabled variant, set all four feature flags true explicitly; repository
defaults remain false and GIF search stays disabled until its provider setup.

Refreshed frontend-origin checks returned HTTP 200 for the site, worker, manifest
and a discussion deep link, with the expected content types and SPA fallback.
The earlier Cloudflare 403 did not recur. This does not identify the hosted
revision or confirm Pages build flags, and an installed-device PWA check remains
part of deployment verification. Pages configuration changes, production-branch
push and deployment require explicit authorization. A Pages-only frontend
release does not require Docker.

Controlled live acceptance on `7444229` published one test root and one direct
Reply from the actual editor, using a disposable identity and zero sats. All
five selected public relays accepted both events. An independent Go client
retrieved both from every relay and verified their IDs, signatures and direct
reply relationship. nostr.build returned HTTP 201; its hosted PNG matched the
498-byte source and SHA-256, and appeared in the discussion after reload.
The original browser harness omitted the provider's returned `blossom.band`
hostname and blocked two image GETs. A corrected read-only check loaded the
image with no blocked writes; distinguish this harness failure from delivery.

Initial authorized uploads exposed two compatibility gaps. Primal's
Base64 decoding failure is addressed by the origin-specific rule above.
nostrcheck.me accepted its initial upload with
HTTP 202; the old adapter rejected its processing URL. The queued-processing
adapter now reads completed metadata. Replaying the recorded POST response and
performing a real authenticated GET for that existing job returned the final
WebP metadata without another transfer. The hosted 464-byte WebP matched its
reported transformed SHA-256 and preserved the original hash separately.
Local and browser fixtures cover queued processing, cancellation, bounded reads,
single-use tokens and safe destinations. Fresh browser transfers on `236a1c7`
returned HTTP 200 from both providers and inserted their URLs into the draft
without page errors. Independent HTTP reads verified Primal's 498-byte PNG,
including its HTTPS CDN redirect, and nostrcheck.me's 464-byte WebP against their
reported hashes. nostrcheck.me returned an existing-file response in this repeat;
it did not exercise a newly queued processing job. No additional note was signed
or published. Live partial-delivery recovery and physical signer publishing
remain open gates.
Public events and files may persist; cleanup events, spending and additional
uploads or publication beyond the approved scope require separate authorization.

Continue implementation and automated verification without waiting for the
maintainer to provide a device, wallet or manual test session. Pending external
checks do not block discussion retrieval development in the isolated worktree.
The implementing agent owns repeatable local protocol, recovery, browser and
build checks, including automation for additional reproducible failures.

Current `236a1c7` preparation also passed application and retained-module race
checks, reconstruction of all 92 retained upstream files, both production
frontend configurations and their eight-route read smokes. The enabled container
smoke passed ten checks, including both backend images, real nginx/API/WebSocket
paths, shutdown, identity and pending-invoice retention, and the opt-in Reply
chunk. Its four blocked external browser reads are intentional isolation, not
successful public requests. Disposable containers, volumes and images were
removed and Docker Desktop was stopped after verification.

The candidate Go command handler accepted NIP-17 and legacy NIP-04 requests
generated by an independent `nostr-tools` 2.25.2 client. Its signed replies and
quote were published to a real loopback Khatru WebSocket and retrieved by that
client. Independent reads verified event IDs and signatures, the NIP-17 seal and sender,
the exact rumor reply parent and the same rumor in the sender-history copy.
Repeated commands retained two mock invoices, one per distinct request. The
client also verified the account quote's `q` relationship and `nevent` author
and relay hint. This establishes cross-library interoperability locally;
public inbox routing and real wallet settlement retain their own checks.

The candidate Go NWC backend also read the configured receiving wallet's info,
created one real 1-sat invoice and confirmed its unpaid status. An independent
decoder matched the BOLT11 amount and payment hash. The invoice and original
event survived reopening a separate test ledger. No discovery or account event
was published, and no funds were sent. Creating this invoice does not verify
settlement: payment, duplicate-credit prevention and retention of the settled
receipt still require the actual paid invoice. Keep credentials, full invoices
and the candidate ledger outside the repository and public artifacts.

Keep release evidence scoped to what was exercised. Local DM and NWC fixtures
do not establish public-client routing or live-wallet settlement.
Before releasing the migrated backend, retain the passing container acceptance
and complete controlled interoperability checks for existing DM, payment and
publication flows. Actual signer checks must cover the enabled publishing actions;
signer defaults remain disabled until release acceptance is complete. Record
unavailable checks as open release gates,
without marking them passed or assigning routine verification to the maintainer.

Keep the remaining gates separate so a frontend release with disabled features
can proceed once its own gates pass, without claiming signer, publication or
migrated-backend acceptance:

| Gate | Agent-owned preparation and local evidence | Evidence still requiring the actual environment |
| --- | --- | --- |
| Container release | `npm run test:release-containers` from `web/` builds both backend targets, exercises real Compose/nginx/API/WebSocket paths and mock-invoice restart retention, and checks the disabled frontend plus opt-in Compose arguments. Add `-- --with-features` for an enabled container release. | Deployment-origin health, unchanged production identity and ledger, installed-PWA update and rollback readiness. |
| Signers | Existing extension/NIP-46 fixtures cover pairing methods, signatures, cancellation, account changes, permissions and restoration. Keep every feature flag false by default. | Record OS, browser and signer versions for same-phone Amber handoff/return, desktop-to-phone QR, pasted bunker pairing, rejection and reconnect; include a second independent remote signer and supported desktop extension. |
| Public delivery | Durable outbox, exact-ID retries and per-relay outcomes are locally exercised. A controlled editor Reply was accepted and independently retrieved with verified relationships from five public relays. Fresh Primal and nostrcheck.me browser transfers and independently retrieved files pass after compatibility corrections. | Live partial-delivery recovery, a newly queued provider job through the corrected editor and physical signer publishing. |
| Payments and DMs | Isolated protocol and recovery fixtures, anonymous mock-invoice container checks, and independent-client NIP-17/NIP-04 exchange through local Khatru. | Public inbox routing and live-wallet settlement within an explicitly approved recipient and spending budget. |

Record connection approval and event-publication approval separately. Device
connection checks can verify identity and cancellation without publishing. A
signed reply still requires its own explicit publication consent. Do not run
live DM or wallet tests merely because a container smoke passed. Track versioned
results and unresolved failures in this reference; a phone-sized browser test
does not close a physical-device gate.

`TestProductionDMFlow` is opt-in and is skipped by the default Go test suite.
It publishes public discovery metadata and sends a production DM that creates
an unpaid invoice. Do not use it as an automatic substitute for isolated tests;
its external actions require the explicit authorization described above.

### Release checks

Security, connection lifetime, discovery, cache, thread primitives and durable
routing can ship as one foundation change. Opt-in discussion/profile screens
and profile NIP-05 verification are separate from foundation acceptance.

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
