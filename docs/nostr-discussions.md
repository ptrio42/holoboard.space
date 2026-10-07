# Discussion assembly: client comparison and design gate

Status: source research and a proposed direction for Holoboard. No discussion
assembler or discussion screen is implemented by this document. The shared
transport and cache are described in [the Nostr reference](nostr.md).

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

## Protocol semantics and Holoboard's current gaps

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

These limitations are acceptable boundaries for the existing context links,
not evidence that the helper is ready to serve as the discussion assembler.

## Proposed implementation stages

Implement against the original-item anchor and all-discovered-replies policy
above. Keep presentation choices explicit when deciding how much ancestor
context to show for a promoted reply. Proceed with these stages:

1. Define normalized references with protocol provenance, declared root scope,
   direct parent, exact IDs, address aliases and resolution/conflict states.
   Compare reusable pure Applesauce/Welshman helpers against fixtures before
   adopting a library. Reuse must preserve Holoboard's transport, budgets and
   storage boundaries; importing a second framework is not an automatic choice.
2. Build and test a pure graph reducer and its reverse parent index. Keep one
   node per exact event ID, explicit alias rules and deterministic conflict
   handling. Missing or hidden parents preserve children through placeholders.
   A signed root claim does not automatically override a contradictory parent.
3. Coordinate ancestor resolution separately from descendant discovery. Use
   known authors' write relays for exact ancestors and candidate reply sources,
   including relevant inbox relays, for descendants. The root author's outbox
   cannot enumerate unknown respondents. Keep branch/source coverage and cursors;
   cancellation and bounded work use the shared admission layer.
4. Choose the initial projection with realistic phone fixtures: focused path,
   expandable tree or a combination. Keep ordering and visibility separate from
   topology. Evaluate same-author continuations explicitly, including chronological
   author series, without silently inheriting a client's personalized ranking.

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
  references do not silently move to a newer address version.
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

Runtime performance, scroll stability, adversarial-load behavior and deployed
client compatibility remain unverified by this source comparison. They require
fixtures and browser tests during implementation; no full-coverage claim is made.
