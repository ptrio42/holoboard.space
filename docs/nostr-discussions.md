# Discussion assembly: client comparison and design gate

Status: the protocol normalizer, bounded metadata graph and network coordinator
are implemented. An opt-in read-only discussion screen consumes these services.
The client comparison below records source evidence and presentation proposals.
The shared transport and cache are described in [the Nostr reference](nostr.md).

## Assessment

Holoboard is intended to grow into a small Nostr client. Correct protocol
relationships are therefore a core capability shared by discussions and future
profile surfaces. Keep the relation engine reusable and independent of payment,
ranking and board-specific presentation. Holoboard's product rules choose the
focus and decorate the observed graph; they must not reinterpret signed reply
relationships to make the board appear to be the conversation root.

Holoboard's discussion product contract guides the assembler. The existing
product promotes signed notes and comments, including
other people's posts. A promoted item can already be a nested reply. Its author,
the payer and the Holoboard account are distinct identities. The promotional
quote is a separate event, and current board rank comes from promotion payments.
See [the product description](../README.md).

The discussion anchor is the original promoted item. Replies to Holoboard's
promotional quote belong to a separate conversation and must not be merged into
that item's discussion. The proposed presentation keeps the promoted item as
the focus when it is itself a reply, with its ancestors available as context.
The focused promoted item and the protocol root are separate concepts. Preserve
the item's actual parent and root even when only its subtree is initially shown.
Expiry and renewed promotion keep the discussion attached to the same original
event ID; promotion lifecycle changes its decoration, not its identity.

Show all discovered replies belonging to that discussion, with promoted replies
visually distinguished using Holoboard's promotion records for the exact event
ID. An unpaid reply can connect promoted descendants to their ancestors and
must remain in the graph. Promotion metadata decorates a node; it does not
change parent edges or automatically promote any related event. Observed replies
do not change the paid board's membership or ranking.

Default sibling sorting, expansion and moderation presentation remain product
decisions. Do not import account-following relevance into paid board ranking.
Technical examples below are comparison material; the Holoboard-specific rules
above determine which parts apply.

Keep a normalized graph independent of its presentation. That graph can support
both an expandable tree and a focused conversation view without changing which
event answers which parent. Fetching candidates, interpreting references,
resolving missing nodes, choosing sibling order and rendering branches are
separate decisions. The inspected clients make different choices on these axes.

For Holoboard, the proposed starting point is a bounded graph with explicit
missing-parent states, a focused ancestor path and expandable reply branches.
This is an engineering recommendation. Default sorting, expansion depth and
whether the initial screen shows one branch or the whole observed tree remain
product decisions. Inspecting another client does not establish its policy as
the protocol rule.

## Scope and reproducibility

Source snapshots were inspected on 2026-10-07. These are repository revisions,
not verified versions of the clients' deployed applications. The review read
source and existing fixtures; it did not build the clients, execute their
dependencies or benchmark production behavior.

| Client | Inspected revision | Confirmed presentation strategy |
| --- | --- | --- |
| noStrudel | `38f0eb9f6d9b4212910fecdff445f7a1a16e3349` | Recursive direct-reply branches backed by an event store, with a separate ancestor chain. |
| Coracle | `e4f46ebc0e297927adc8f16fdb7fd8d9a91f6e00` | Context-dependent nested reply previews and explicit expansion, plus a separate ancestor detail view. |
| Primal web | `c96ee211043c6fee8a8b7c431746aab06392f765` | Ancestors of the focused note and its direct replies, using a server thread query. |
| Amethyst shared thread model | `de53ffa402e884c5aecbc81b239e146d484145a3` | Cached graph assembly followed by a flat list sorted by ancestry and author relevance. |

noStrudel's lockfile resolves `applesauce-common` and `applesauce-core` to 6.2.0.
Coracle resolves Welshman packages to 0.12.2. Their published package code was
also inspected, rather than assuming helper behavior from names or current
library documentation. Scope below is limited to the cited paths.

## Confirmed implementations

### noStrudel: reactive branches

[`ThreadView`](https://github.com/hzrd149/nostrudel/blob/38f0eb9f6d9b4212910fecdff445f7a1a16e3349/src/views/thread/index.tsx)
loads the focused note and root separately. Its ancestor component follows
`Note.replyingTo$` and renders a loading link when a referenced parent is absent.
[`ThreadPost`](https://github.com/hzrd149/nostrudel/blob/38f0eb9f6d9b4212910fecdff445f7a1a16e3349/src/views/thread/components/thread-post.tsx)
renders `Note.replies$` recursively, with expansion state and muted placeholders.
The cast uses a direct-reply model, rather than treating every `#e` match as a
child. The focused note's
[`details tabs`](https://github.com/hzrd149/nostrudel/blob/38f0eb9f6d9b4212910fecdff445f7a1a16e3349/src/views/thread/components/details-tabs.tsx)
query its references on read relays including the author's inbox relays.
[`The root timeline loader`](https://github.com/hzrd149/nostrudel/blob/38f0eb9f6d9b4212910fecdff445f7a1a16e3349/src/hooks/use-thread-timeline-loader.ts)
separately seeds the store through root `#e` and `#q` queries.

The useful separation is the store-derived relationship model versus network
loading. NIP-22 comments have a separate component path. Its sibling comparator
uses descending timestamps without an explicit ID tie-break. The ancestor and
branch components recurse; these paths alone do not establish a bounded depth.
This is not evidence that every descendant can be discovered from the root query.

Package evidence:
[Note cast](https://unpkg.com/applesauce-common@6.2.0/dist/casts/note.js),
[RepliesModel](https://unpkg.com/applesauce-common@6.2.0/dist/models/thread.js),
[NIP-22 pointers](https://unpkg.com/applesauce-common@6.2.0/dist/helpers/comment.js).
The package also exports an incremental `ThreadModel` with a pending-parent
index. The inspected thread screen uses Note casts, so that older model must
not be presented as the screen's active assembly path.

### Coracle: context and selective expansion

[`FeedItem`](https://github.com/coracle-social/coracle/blob/e4f46ebc0e297927adc8f16fdb7fd8d9a91f6e00/src/app/shared/FeedItem.svelte)
derives candidate replies from the repository, then checks `isChildOf` before
rendering. Context, depth, collapse state and explicit reveal determine which
replies are visible. Without explicit reveal, it limits visible replies to
three. This is a presentation policy; the retained reply set can be larger.
[`Note`](https://github.com/coracle-social/coracle/blob/e4f46ebc0e297927adc8f16fdb7fd8d9a91f6e00/src/app/shared/Note.svelte)
loads interaction candidates from the event author's inbox relays.

[`Ancestor helpers`](https://github.com/coracle-social/coracle/blob/e4f46ebc0e297927adc8f16fdb7fd8d9a91f6e00/src/engine/utils/events.ts)
retain parent IDs and addresses as arrays, and child matching accepts the
parent's ID or address. The separate
[`ThreadDetail`](https://github.com/coracle-social/coracle/blob/e4f46ebc0e297927adc8f16fdb7fd8d9a91f6e00/src/app/views/ThreadDetail.svelte)
loads ancestors recursively, distinguishes root and direct parent, and can
collapse intermediate ancestors. Intermediate ancestors are displayed by date,
so the displayed order is not necessarily a topological parent path when clocks
are skewed.

The useful pattern is separating candidate queries from semantic child matching.
Visibility rules need explicit review: the
[`feed reducer`](https://github.com/coracle-social/coracle/blob/e4f46ebc0e297927adc8f16fdb7fd8d9a91f6e00/src/app/shared/NoteReducer.svelte)
can skip a branch when a resolved parent is deleted or muted. That path concerns
feed reduction, not a demonstrated rule for every Coracle discussion surface.

Package evidence:
[Welshman reply parsing](https://unpkg.com/@welshman/domain@0.12.2/dist/domain/src/kinds/Note.js),
[comment parsing](https://unpkg.com/@welshman/domain@0.12.2/dist/domain/src/kinds/Comment.js),
[candidate filters](https://unpkg.com/@welshman/util@0.12.2/dist/util/src/Filters.js).

### Primal: focused conversation and server discovery

[`NoteThread`](https://github.com/PrimalHQ/primal-web-app/blob/c96ee211043c6fee8a8b7c431746aab06392f765/src/pages/NoteThread.tsx)
walks `replyTo` links with repeat detection to identify ancestors. It displays
them in ascending date order. Replies are restricted to notes whose `replyTo`
equals the focused note's ID; deeper replies become the next focused conversation.
This avoids rendering the entire observed tree at once.

The
[`thread context`](https://github.com/PrimalHQ/primal-web-app/blob/c96ee211043c6fee8a8b7c431746aab06392f765/src/contexts/ThreadContext.tsx)
loads data through `fetchMultiThread`. Its
[`request`](https://github.com/PrimalHQ/primal-web-app/blob/c96ee211043c6fee8a8b7c431746aab06392f765/src/lib/feed.ts)
uses the cache command `multi_kind_thread_view`, rather than ordinary browser
relay filters. Thread pagination is disabled in the inspected context. This
shows a dependency on server discovery; it does not establish that the server
finds a complete conversation. Server internals were not audited here.

One confirmed compatibility pitfall is in
[`extractReplyTo`](https://github.com/PrimalHQ/primal-web-app/blob/c96ee211043c6fee8a8b7c431746aab06392f765/src/stores/megaFeed.ts):
it initializes the candidate to an empty array and guards positional fallback
with `!replyTo`. Arrays are truthy, so that fallback is unreachable in this
revision. The older note converter uses `undefined` instead. This is a static
control-flow finding, not a reproduced failure of the deployed Primal service.

### Amethyst: graph assembly and a ranked flat projection

[`ThreadAssembler`](https://github.com/vitorpamplona/amethyst/blob/de53ffa402e884c5aecbc81b239e146d484145a3/commons/src/commonMain/kotlin/com/vitorpamplona/amethyst/commons/model/ThreadAssembler.kt)
searches for a root and collects cached ancestors and descendants. Cache-backed
Note objects can exist before their events are available. Thread traversal has
visited membership checks and treats reactions, zaps and reposts as conversation
boundaries, instead of following every cross-reference into another conversation.
Existing
[`fixtures`](https://github.com/vitorpamplona/amethyst/blob/de53ffa402e884c5aecbc81b239e146d484145a3/commons/src/commonTest/kotlin/com/vitorpamplona/amethyst/commons/model/ThreadAssemblerTest.kt)
cover the reaction/zap boundary.

[`ThreadLevelCalculator`](https://github.com/vitorpamplona/amethyst/blob/de53ffa402e884c5aecbc81b239e146d484145a3/commons/src/commonMain/kotlin/com/vitorpamplona/amethyst/commons/model/ThreadLevelCalculator.kt)
derives ancestry signatures. Same-author continuations, the current user and
followed users influence ordering. It seeds a provisional signature before
recursion to terminate alias cycles. The
[`feed filter`](https://github.com/vitorpamplona/amethyst/blob/de53ffa402e884c5aecbc81b239e146d484145a3/commons/src/commonMain/kotlin/com/vitorpamplona/amethyst/commons/viewmodels/thread/ThreadFeedFilter.kt)
sorts the resulting flat list with an ID tie-break.

Discovery uses separate
[`root-reference subscriptions`](https://github.com/vitorpamplona/amethyst/blob/de53ffa402e884c5aecbc81b239e146d484145a3/commons/src/commonMain/kotlin/com/vitorpamplona/amethyst/commons/relayClient/thread/FilterEventsInThreadForRoot.kt)
and
[`missing-event resolution`](https://github.com/vitorpamplona/amethyst/blob/de53ffa402e884c5aecbc81b239e146d484145a3/commons/src/commonMain/kotlin/com/vitorpamplona/amethyst/commons/relayClient/thread/FilterMissingEventsForThread.kt).
Root queries consider uppercase and lowercase ID/address references. Missing
addresses have their own resolution path. These are useful architectural
examples, but their account-dependent ranking is a product choice. An ID
tie-break does not by itself prove arrival-order-independent alias resolution.

A source-level caution is `OnlyLatestVersionSet` in the assembler: adding a newer
distinct Note for an address does not remove an older Note already added to its
internal set. Reversing insertion order can therefore change that set when both
versions reach it. This is confirmed class behavior from the code; whether the
live cache supplies those distinct objects in a particular screen was not tested.
Do not infer version deduplication guarantees from the class name alone.

## Protocol semantics and context-link limitations

[NIP-10](https://github.com/nostr-protocol/nips/blob/master/10.md) defines marked
root/reply references and deprecated positional references. A root-only marked
tag can describe a direct reply to the root. A sole unmarked tag gives a legacy
reply target; it does not independently establish the ultimate ancestor.
Quotes and mention references must not become reply edges merely because a
relay returned them for `#e`.

[NIP-22](https://github.com/nostr-protocol/nips/blob/master/22.md) separates
uppercase root scope from lowercase parent references and requires kind tags.
A parent can carry both an address and an exact event ID. Stable addresses and
exact versions need distinct identities. External scopes also extend beyond
HTTP(S) URLs.

Confirmed limitations of Holoboard's current `threadContext` helper:

- It extracts a root and parent, but does not assemble or validate ancestry.
- A sole positional `e` currently populates both fields without recording that
  the ultimate root remains uncertain.
- NIP-22 selects the first matching reference tag, so `a` and `e` aliases can
  produce different selected reference types after a tag permutation.
- It does not validate `K/k`, reconcile `P/p`, represent conflicting references
  or retain unsupported external scopes.

These remain boundaries of the existing context links. The new graph uses
`threadRelations.ts` instead of deriving ancestry from `threadContext`.

## Implemented relation model

[`threadRelations.ts`](../web/src/lib/threadRelations.ts) normalizes kind 1 and
kind 1111 metadata. It preserves marked/positional provenance, separates root
claims from direct parents, coalesces repeated hints and reports invalid or
conflicting references without selecting an arbitrary winner. A sole positional
reference does not establish the ultimate root. In mixed marked/unmarked notes,
unmarked tags cannot override the marked relationship. Unknown markers do not
acquire positional semantics. This conservative compatibility policy avoids
turning a mention into an inferred parent.

NIP-22 address and exact-ID tags form one target regardless of tag order. An
exact ID pins its version, even while missing. Kind and author claims are
validated, including against a referenced event when it arrives. Required K/k
or Nostr author metadata that is absent leaves an invalid claim, while the
candidate remains available for diagnostics. Additional lowercase p tags may be
mentions: when the author is ambiguous, the graph checks the loaded parent
against the tagged candidates. Uppercase P has no equivalent mention role.
External values and their kind strings remain opaque, including unsupported
NIP-73 types. They are not automatically converted into URLs or fetched.

[`threadGraph.ts`](../web/src/lib/threadGraph.ts) is a pure metadata reducer:

- `createThreadGraph` sets bounded retention. `reduceThreadGraph` admits verified
  event metadata in batches, rebuilding parent edges and a reverse child index.
  Signature validation belongs to the existing read ingress, not this module.
  Content and signatures remain outside this graph. Callers must share one
  graph store across views rather than allocating an independent store per row.
- One node represents one exact event ID. Latest-address resolution uses the
  newest timestamp and lowest ID on ties, retaining loaded older exact versions.
  Missing event/address targets have placeholders. Root claims never create
  parent edges, and conflicting roots remain diagnostic without overriding a
  valid direct parent. Every edge inside a detected cycle is rejected.
- `projectThread` takes an exact focus ID and returns ancestors in edge order
  plus bounded descendant rows. Hidden/deleted rows preserve their position and
  children. Those flags are caller-supplied visibility verdicts; the graph does
  not itself authenticate deletion requests or decide moderation. An optional
  sibling comparator changes presentation only, with an ID tie-break. The
  default key order is deterministic and does not finalize the product's sort.

Default ceilings are 2048 loaded metadata records, 6144 nodes including
placeholders, 8 MiB of estimated serialized metadata, 256 KiB per record, 512
inputs per batch and 128 ancestor/descendant levels per projection. Callers can
lower these limits. They must split larger batches; dropped inputs and retention
pressure set a sticky `limited` flag. Retention keeps an ID-sorted prefix rather
than an arrival-order LRU. The estimates bound stored metadata, not total heap
usage including indexes and temporary projections. Valid parent edges beyond
the projection depth stay in the graph. Local retention loss does not establish
anything about relay coverage. `loadedReplyCount` counts the returned loaded
reply rows, never a network-wide total.

The metadata fixtures cover shuffled arrivals and incremental batches, clock
skew, missing/late parents, quotes, original-item versus promotional-quote
conversations, unpaid intermediate replies, hidden/deleted placeholders,
conflicting claims, address updates and pinned versions, external scopes, cycle
defenses and resource ceilings. Synthetic IDs isolate graph semantics; existing
read-ingress tests separately exercise signed-event verification. These unit
tests do not verify browser scrolling or real-network descendant discovery; the
screen has separate browser fixtures.

### Dependency decision

The inspected Applesauce 6.2.0 helpers preserve useful address/ID pointers but
choose individual tags and do not expose the conflict/provenance model required
here. Welshman 0.12.2 separates NIP-22 tag groups and ID/address fields, but also
needs application-level validation and ancestry resolution. These conclusions
come from the pinned sources linked above; these packages were not installed
or executed as part of this implementation.

The installed `nostr-tools` 2.25.2 NIP-10 parser was exercised in regression
fixtures. It supplies a root fallback for a sole positional parent and chooses
one conflicting marked parent according to tag order. Those heuristics cannot
serve as authoritative root/conflict states. The small application normalizer
therefore interprets the referenced NIPs directly. No extra framework, relay
pool or cryptographic implementation was added.

### Implemented retrieval coordinator

[`discussionReads.ts`](../web/src/lib/discussionReads.ts) separates exact ancestor
resolution from NIP-10/NIP-22 candidate discovery. It shares the verified read
cache, transport, resource admission and one metadata graph across active views.
Reference/source hints participate in author relay discovery; ancestors use
write relays, while descendant candidates also use relevant read relays.
Root claims can reveal candidates with unloaded parents, but never create edges
or merge those candidates into a focused subtree. Only resolved connected
descendants expand the discovery frontier. A promoted middle reply retains its
actual ancestor context without querying every sibling of the protocol root.

Each predicate/relay pair retains its own pagination and failure state. Inclusive
timestamp ties expand to 512; an unresolved saturated boundary reports
truncation. Failed relays retry the same cursor independently. Cache hits do not
claim network coverage, and local retention loss remains separate. Views of
the same exact focus share work; the final view cancels it. Detailed API,
limits and lifetime behavior are in [the Nostr reference](nostr.md#discussion-retrieval).
Signed-event fixtures and wire tests establish local behavior, not deployed
client interoperability or discovery of every reply on the Nostr network.

## Implemented reading screen and remaining stages

The opt-in discussion screen combines a focused ancestor path with expandable
reply branches. `VITE_ENABLE_DISCUSSIONS` is disabled by default. The original
signed event remains the center, including a promoted middle reply. Current
promotion badges join exact event IDs from board data. They cannot affect
ancestry, reply ordering or board membership.

Siblings use ascending timestamps and an ID tie-break. Ancestors stay in edge
order even with clock skew. Same-author series use the same sibling policy;
account-dependent client ranking is not inherited. Root-only evidence with an
unresolved parent path stays in a separate unresolved-branches section. Late
parents preserve opened branches, while an explicit collapse remains effective.
Pages render at most 48 replies per section and initially eight ancestors;
retained records outside that display window remain reachable. Counts describe
found connected replies. Coverage details and retention limits stay visible,
and additional network batches require `Load more`.

Branch state survives internal focus navigation and reloads within a bounded
session-storage record. The board stays mounted during discussion reading.
Visible note anchors are preserved during graph updates when the note remains
rendered; arbitrary media resizing and browser scroll clamping are not a
universal no-jump guarantee. The read uses a fixed session timestamp, not a live
reply feed. Closing and reopening refreshes that timestamp. Full screen behavior
and configuration are in [the Nostr reference](nostr.md#discussion-screen).

Dedicated profile screens, deletion/moderation discovery and user-authored
replies remain separate stages. Controlled real-relay reading and finite runtime
heap/navigation checks now supplement local signed-event fixtures. Their scope,
results and repeatable commands are in
[the Nostr reference](nostr.md#real-relay-and-runtime-resource-checks).

## Acceptance before a discussion screen ships

- Original-item replies and replies to Holoboard's promotional quote stay
  separate. Paid and unpaid nodes can alternate along one preserved branch;
  promotion highlighting cannot change its topology or the paid board ranking.
- For the same observed event set, shuffled arrivals and incremental batches
  produce identical resolved edges and deterministic ordering for the same
  ranking inputs. Clock skew cannot reorder an ancestor path incorrectly.
- Fixtures cover marked, positional, root-only, reply-only, mixed and conflicting
  NIP-10 references; quotes and mention-only references never become replies.
- NIP-22 address/ID aliases work in either tag order. Kind/author contradictions,
  address updates and unsupported external scopes remain explicit. Exact ID
  references do not silently move to a newer address version. An opaque external
  scope whose text matches a Nostr address cannot resolve through that alias.
- Missing, late, deleted and muted parents preserve loaded descendants. Resolving
  a placeholder does not duplicate nodes, reset expanded branches or jump the
  reader's scroll position. Root claims alone cannot merge unrelated threads.
- Deep graphs and address-alias cycles terminate within explicit node, depth,
  lookup and subscription bounds. UI collapse alone is not a resource budget.
- Descendant pagination covers unequal relay date ranges and saturated timestamp
  ties. Timeouts, CLOSED, unavailable relays and budget exhaustion preserve data
  and expose partial coverage. Counts distinguish loaded replies from any
  externally supplied total; EOSE never promises network-wide completeness.
- Opening a middle reply works before its root arrives. Same-author series,
  sibling conversations and comments on reactions/zaps retain their own context.

The unit fixtures establish the implemented graph properties within its stated
bounds. Browser fixtures separately exercise the reading screen. Public-relay
checks loaded a kind-1 focus, a promoted middle kind-1111 comment with its parent
and root, and a kind-30023 article with ID and address read scopes. Failed sources
and unqueried work stayed explicit. Production-bundle checks cover 24 rotations
through four cache-backed, 128-reply trees, plus eight cancelled-read cycles per
browser project. Heap evidence covers retained Chromium JavaScript after garbage
collection, not total browser memory or all future workloads. These checks do
not establish deployed-client compatibility or network-wide completeness.
