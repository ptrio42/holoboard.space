# Holoboard HTTP API

The API shares the relay's HTTP origin. With Docker Compose, paths are prefixed
by `/relay`, for example `http://localhost:8080/relay/api/board`. Requests and
responses use JSON. Promotion endpoints require no login.

## Preview a note

`POST /api/promote/preview`

```json
{"note": "<note reference>"}
```

References can be a 64-character event ID, `note1`, `nevent1` or a link containing
one. The response contains the signed original `event`, `active`, `sats_paid`,
`weight`, `rank` (0 if inactive), optional `billboard`, `billboard_fee_sats` and
`images`, plus `author_share` (integer percent, default 20 for new campaigns).
Existing campaigns return their immutable public split, or 0 if no split was
saved, including after expiry. Preview does not create an invoice or board entry. Fetching is rate
limited; unpaid previews are cached in memory for one minute, up to 128 entries.
For new campaigns, confirmed absence of an address in the author's signed
profile returns `author_share: 0`. Failed discovery retains the default of 20.
Note lookup queries reference hints and configured relays while discovering the
author's [NIP-65 write relays](https://github.com/nostr-protocol/nips/blob/master/65.md)
in parallel. Slow candidate relays do not postpone the outbox lookup until the
request deadline. Hints are preserved when the reference is a client URL.
An exact-ID lookup finishes as soon as a verified matching event arrives,
without waiting for the relay's EOSE response. The request deadline or client
disconnect cancels the remaining lookups and closes their subscriptions and
connections. When a reference carries neither relay hints nor an author, the
note must be on a configured relay or in the board's existing storage and cache.

## Private posts awaiting payment

The opt-in creation flow adds an optional signed `event` to
`POST /api/promote/preview`, `/api/promote`, `/api/support` and
`/api/support/invoice`. `note` may be omitted with `event`; if supplied it must
identify that exact event. Existing reference-only requests remain compatible.

```json
{"event": {"id":"...","pubkey":"...","kind":1,"created_at":0,"tags":[],"content":"...","sig":"..."}, "amount_sats":210, "author_share":0}
```

The example abbreviates cryptographic values; callers must provide a complete,
valid signature and computed ID. Limits are 128 KiB per JSON request, 16 KiB of
nonempty text, 256 tags and 32 distinct verified quotes. New root posts use kind 1
and `q` tags rather than thread `e`/`E` tags. Quote authors are checked against
verified source events before invoice preparation. Unsupported or mismatched
snapshots return HTTP 400. `ENABLE_POST_CREATION=false` returns 503 for fresh
admission but permits supplied snapshots belonging to existing invoice sessions.

Private preview events do not enter the shared ID cache. An ID alone cannot
retrieve an unpaid invoice snapshot through preview, board HTTP or Nostr reads.
No public zap request for a new private post is forwarded to the author's wallet;
ordinary private author-support invoices remain available. Missing profiles remain
`unavailable`, distinct from a signed profile confirming `no_address`.

Guest attribution is self-reported by the author's signed
`["L","space.holoboard.attribution"]` and
`["l","anonymous","space.holoboard.attribution"]` tags
([NIP-32](https://github.com/nostr-protocol/nips/blob/master/32.md#self-reporting)).
It requires explicit `author_share:0` and no account notification recipient.
No payer boolean can rename another signed author. The label is application
semantics, not proof of anonymity or key freshness.

Invoice settlement atomically adds visibility and a durable original publication.
The original must be accepted by each destination before that destination receives
the Holoboard quote, including destinations added by later routing. Retry keeps
the same IDs; duplicate settlements cannot add credit twice. Operator removal
stops pending root and quote delivery. Already public originals cannot be erased
by the Holoboard account. Status responses add optional `publication`:
`pending`, `delivered` or `stopped`, independently of `settled`.

## Preview a page link

`GET /api/link-preview?url=<encoded HTTP(S) URL>`

Returns `url` (the final fetched URL), `title`, optional `description` and
optional `image_url`. Reads [Open Graph](https://ogp.me/) metadata with HTML
title and description fallbacks. Relative thumbnails resolve against the final
page URL; metadata cannot replace the card destination. No HTML is returned.
Missing metadata or failed upstream content returns HTTP 502, so clients retain
the original link. Invalid or private target URLs return HTTP 400.

Fetches allow only public HTTP(S) targets on their default ports without
credentials. DNS answers are checked and pinned before connection, and each
redirect is validated, following the
[OWASP SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).
Limits are 5 seconds, 1 MiB of decoded HTML and 3 redirects. A bounded 512-entry
memory cache retains successes for one hour and failures for one minute.
Concurrent requests share a fetch; 60 uncached requests per client per minute
are allowed, with at most 8 upstream fetches at once. Cached results remain
available at the rate limit.

Note lookup failures distinguish completed absence (404), a deadline (504) and
incomplete or busy relay discovery (503). Clients can retry 503/504; they must
not interpret them as proof that the event does not exist.

## Create an invoice

`POST /api/promote`

```json
{"note": "<note reference>", "amount_sats": 1000}
```

Omitting `amount_sats`, or passing zero for an ordinary promotion, uses
`DEFAULT_PAYMENT_SATS`. The response includes `invoice`, `payment_hash`,
`note_id`, `expires_at` (Unix seconds), total `amount_sats`, `promotion_sats` and
`billboard_fee_sats`.

The visibility minimum is 1 sat; the API maximum is 10,000,000 sats. Optional
`author_share` accepts integers from 0 to 99. It selects the public NIP-57 split
on the first successful promotion, defaulting to 20% author and 80% Holoboard.
The first settlement wins when multiple invoices are pending. Boosts and revivals
cannot replace that split or the signed public quote. This field never redirects
part of the Holoboard invoice: `amount_sats` is entirely visibility. Clients
prepare author invoices separately using the support endpoints below.
Confirmed absence of an author payment address makes the first public quote
visibility only. This also applies to invoices prepared before the author
removed their address; invoice amounts and separate author invoices stay fixed.
Temporary lookup failures preserve the requested public split.

To request a confirmation DM, add an npub or a 64-character hex public key:

```json
{
  "note": "<note reference>",
  "amount_sats": 1000,
  "notify_pubkey": "npub1..."
}
```

The field is optional and does not authenticate the request. After settlement,
Holoboard sends a confirmation DM using NIP-17. The recipient must reply
directly with `YES` to that DM, or send `NOTIFY <note_id>`, before one
notification is scheduled for the current activity period. Invalid public keys
return HTTP 400. The public key is kept in private relay storage and is not
returned by board APIs.

To buy appearance, add `billboard`:

```json
{
  "note": "<note reference>",
  "amount_sats": 1000,
  "billboard": {
    "template": "led",
    "color": "cyan",
    "size": "medium",
    "speed": "normal",
    "text": "An exact fragment from the original note"
  }
}
```

| Field | Allowed values |
| --- | --- |
| `template` | `led`, `neon`, `image-led`, `terminal`, `split-flap`, `glitch`, `poster`, `slides` |
| `color` | `cyan`, `pink`, `gold` |
| `size` | `small`, `medium`, `large` |
| `speed` | `slow`, `normal`, `fast` |
| `text` | Nonblank exact substring of the original content, up to 160 Unicode code points. |
| `slides` | Only for `slides`: 1 to 3 nonblank exact substrings, up to 160 Unicode code points combined. `text` must equal the first fragment. |
| `image` | Required for `image-led`, optional for `poster`; choose a URL returned in preview's `images`. |

For example, a slides billboard uses `"template": "slides"`,
`"text": "First fragment"` and `"slides": ["First fragment", "Second fragment"]`.
Each fragment must occur in the original note. `text` provides a first-slide
fallback for clients that do not display slides. Other templates omit `slides`.
Slides advance every three seconds in the UI; reduced motion keeps manual
navigation. `speed` controls LED scrolling and terminal typing.

`amount_sats` is the ranking amount; the server adds the appearance fee. Its
introductory price is 100 sats, deliberately low and intended to increase.
Existing invoices keep their quoted fee.

Appearance is available only for an inactive or previously unpromoted note,
with a promotion payment. Any active note, or another unexpired appearance
invoice, returns HTTP 409 for a billboard purchase. `style_only: true` is rejected
with HTTP 400. Ordinary boost invoices remain available to everyone.

The first settled promotion fixes the appearance for the activity period,
including the standard look. Boosts preserve it; expiry ends it. A new promotion
period can purchase appearance again.

## Confirm payment

`GET /api/promote/status?payment_hash=<hash>`

The response includes `pending`, `settled`, `note_id` and `sats_paid`. A settled
invoice also includes `receipt` with:

- `note_id` and total `amount_sats`;
- actual `promotion_sats` and `billboard_fee_sats`;
- `billboard_applied` and `fee_converted`.

Use `settled` and its receipt to confirm this invoice. A missing pending invoice
or a change in the note's total sats is not payment proof.

If another promotion activates the note before a billboard payment settles,
the appearance fee adds ranking credit instead. Legacy appearance-only invoices
also convert their fee to ranking credit. The receipt reports `fee_converted`.
A removed note is never restored by a purchase.

Pending appearance invoices retain the validated original event and quoted fee
across restarts. Settlement persists ranking credit, appearance, receipt and
pending-invoice removal together. Duplicate notifications cannot credit an
invoice twice; a failed disk write rolls back the changes for retry. Allocation
uses the stored invoice amount, independent of wallet notification amounts.
Expired invoices remain stored until settlement; expiry alone does not prove
that an invoice was unpaid. Verified zaps persist their credit and deduplication
markers together, keyed by both receipt ID and invoice payment hash. A failed
validation, fetch or disk write leaves the zap available for retry.
Older data files with no appearance or receipt fields remain valid.

## Read the board

`GET /api/board`

The response has `entries`, `posts`, `total_sats` and `updated_at` (Unix seconds).
Each active entry includes `id`, `sats_paid`, `weight`, `last_paid_at`, `rank`
(1-based) and optional `billboard`. Appearance fees used for appearance are
excluded from promotion totals and ranking weight.

Order by `rank`, not rounded `weight` or Nostr event arrival order. Original
notes come through Nostr; explicit ranks and appearance intentionally use this
API. See the [Nostr transport follow-up](../README.md#nostr-interoperability).

## Read board and waiting-room campaigns

`GET /api/board/campaigns?view=board&page=1`

`view` accepts `board` (default), `top`, `new` or `hot`. `page` is 1-based, with
21 entries per page. `board` contains only global positions 1 through 21. All
waiting-room views contain only active, nonremoved ranks 22 and higher:

- `top`: global rank ascending, starting at 22.
- `new`: first paid promotion time descending. Boosts and revivals do not refresh it.
- `hot`: visibility sats received in the last 24 hours descending, excluding
  entries with no payments in that window. Equal values use global rank.

The response includes `entries`, `targets` (global top three and rank 21),
`total` (selected-view count), `active_posts`, `total_sats` (active visibility
totals), `has_more` and `checked_at` (server snapshot time in Unix milliseconds).
Each entry includes its signed `event`, existing ledger
fields (`id`, `rank`, `weight`, `sats_paid`, `last_paid_at`, optional `billboard`),
plus `first_paid_at`, `hot_sats` and `author_share`. Ranks stay global even when
the view uses a different order. Author tips and applied appearance fees never
enter these totals.

Older files remain valid without a migration. Their first paid time is the
earliest available payment, or the last paid time if no history exists. New
campaigns persist a separate first paid timestamp. Existing public quotes keep
their original tags.

### Include discoveries

Append `include_discoveries=true` to opt into discovery metadata. For `view=new`,
`entries` becomes a union of paid campaigns and unranked discoveries, ordered
by `first_visible_at` (Unix seconds). A discovery's original first appearance
is retained if someone later promotes it. Paid entries in TOP 21 remain outside
the waiting room.

An unranked entry has `entry_type: "discovery"`, `id`, the signed original
`event`, `first_visible_at` and `discovery`. It omits `rank`, `weight`, `sats_paid`
and other promotion ledger fields. The `discovery` object contains `reason`,
`topic`, `language`, `expires_at` (Unix seconds), `reward_sats` and `reward_status`.
Statuses are `pending`, `preparing`, `sending`, `uncertain`, `paid`, `failed` and
`unavailable`. Only `paid` means the reward is confirmed. The amount is an author
reward, never paid visibility. Private invoice and wallet data are not exposed.

Paid entries in mixed New use `entry_type: "promotion"` and retain their existing
ledger fields. They can carry historical `discovery` metadata. Unpaid discoveries
leave active New after seven days; their history and reward journal are retained.

Opted-in responses for any view add `waiting_posts`, counting the deduplicated
union of paid waiting notes and active unranked discoveries. `active_posts` and
`total_sats` remain paid-only. Without the opt-in parameter, existing response
and sorting semantics are unchanged.

## Prepare direct author support

`POST /api/support` with `{"note": "<note reference>"}` returns `available`,
`author`, `min_sats`, `max_sats`, `allows_nostr` and optional `nostr_pubkey`.
If the author has no usable Lightning address, `available` is false and `reason`
explains the fallback. No invoice or payment is created by this lookup.
`reason_code: "no_address"` means a valid signed profile contains neither
Lightning Address nor LNURL after comparing discovered sources, including the
author's [NIP-65 write relays](https://github.com/nostr-protocol/nips/blob/master/65.md).
The newest valid profile wins, with the lowest event ID resolving equal
timestamps as specified in [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md).
Profile lookup includes public metadata discovery relays as well as note hints
and configured relays, even when the author has no discoverable relay list.
Lookup has a five-second budget, shortened by the request's context. An older
address-free profile from another source cannot establish absence when none of
the advertised write relays responds with a profile.
`reason_code: "unavailable"` covers lookup and
provider failures. The client defaults new campaigns to visibility only for
`no_address`; existing campaign splits remain unchanged.

`POST /api/support/invoice`:

```json
{"note": "<note reference>", "amount_sats": 42}
```

This requests an invoice directly from the author's LNURL-pay provider. The
response contains `invoice`, `payment_hash`, `amount_sats`, `expires_at`, `author`
and `nostr_pubkey`. Optional `zap_request` accepts a signed NIP-57 kind 9734
event with exactly one `p` for the author, one `e` for the original note and an
`amount` tag matching the requested millisats. The author's provider must
advertise Nostr support. Without this field, the invoice uses ordinary LNURL-pay
and needs no signer.

LNURL metadata and invoice callbacks may follow up to three redirects. Each
destination must use public HTTPS on port 443 without URL credentials. DNS
addresses are checked before each new connection and the connection uses the
checked address. Redirects share the original ten-second HTTP request timeout.

The service validates the BOLT11 signature, exact amount, network and expiry.
Ordinary invoices may contain a plain description (including an empty one) or
a description hash. Current [LUD-06](https://github.com/lnurl/luds/blob/luds/06.md)
does not require that hash to match LNURL metadata. The invoice comes from the
callback resolved through the author's signed profile and checked public HTTPS.
Public zaps still require a description hash committing to the exact signed
request JSON, as specified by [NIP-57](https://github.com/nostr-protocol/nips/blob/master/57.md).
It never pays or forwards author funds, and this invoice never affects ranking.
The client handles two independent recipient payments and their partial results.
These endpoints share a limit of 20 requests per client address in ten minutes.

## Verify author support

`POST /api/support/verify` accepts either:

```json
{"invoice": "lnbc...", "preimage": "<64-character hex wallet proof>"}
```

or `{"note": "<note reference>", "invoice": "lnbc...", "receipt": <kind 9735 event>}`.
Preimages must hash to the invoice payment hash. Zap receipts must have a valid
signature from the author's advertised LNURL provider, match the invoice hash,
author and original note, and contain a valid signed request and invoice
description hash. A successful response is `{"verified": true}`. Verification
adds no ranking credit and stores no author-payment history. Ordinary manual
payments with no proof cannot be confirmed by this API.
New invoices persist trusted verification context before being returned. A
receipt uses the original recipient and provider key even after profile changes
or restarts; a replacement invoice captures its own provider. Older invoices
without this context use the current provider. Preimage verification needs no
profile lookup. A storage failure returns HTTP 503 without offering the invoice.

## Read expired promotions

`GET /api/board/expired?limit=20`

The response contains `entries` with `event`, `sats_paid` and `last_paid_at`.
`limit` accepts 1 to 50, defaulting to 20. If `next_cursor` is returned, pass it
as `cursor` to retrieve another page. Operator-removed notes are excluded.

## Remove or restore a note

`POST /api/admin/note`, with `Authorization: Bearer <ADMIN_TOKEN>`.

```json
{"note": "<note reference>", "restore": false}
```

Set `restore: true` to lift an earlier removal. The response includes `note_id`,
`status` and, for removal, optional `sats_removed`. Removal does not refund
payments. Without `ADMIN_TOKEN`, this route is not registered.

## Check new waiting-room notes

`GET /api/board/waiting-updates?since=<Unix milliseconds>`

Returns `count`, `note_ids` and `checked_at` (Unix milliseconds). Counts all
active, nonremoved notes currently below position 21 whose first paid promotion
falls after `since` and at or before `checked_at`. Pagination, boosts and sorting
do not affect this definition. Old notes dropping from TOP 21 are not new.
Omitting `since` returns an empty result and the server checkpoint for an initial
visit. Negative, malformed or future timestamps return HTTP 400. Responses use
`Cache-Control: no-store`; no visit history is stored on the server.

Append `include_discoveries=true` to count first discovery appearances as well.
An originally discovered note does not become new again when it receives its
first promotion. All cursor timestamps remain Unix milliseconds.

## Operate the discovery curator

These endpoints require `Authorization: Bearer <CURATOR_TOKEN>`, a dedicated
token that cannot remove posts or change modes. They use `Cache-Control: no-store`.
See the [runner guide](../curator/README.md) for configuration and scheduling.

`GET /api/curator/candidates` returns `batch_id`, up to 50 `candidates`, `policy`,
`recent_selections`, `mode`, `completed` and partial `collection` coverage.
Selection visits distinct authors before taking additional notes from an author;
a per-slot seeded hash rotates the sample without preferring low event IDs.
Each candidate includes the complete signed `event`, `source_relays` and
`first_seen_at` (RFC 3339). Batches are persisted snapshots, expire after 24 hours
and are issued once per UTC twelve-hour slot. Repeated requests return the same
batch; a completed batch returns an empty candidate list. Empty batches should
be skipped without a model call.

`POST /api/curator/decisions` accepts:

```json
{
  "run_id": "<stable unique run ID>",
  "batch_id": "<issued batch ID>",
  "decisions": [{
    "note_id": "<candidate event ID>",
    "selected": true,
    "reason": "An original practical account worth reading.",
    "topic": "community",
    "language": "en",
    "confidence": 0.85,
    "reward_sats": 100
  }]
}
```

The request contains 1 to 50 distinct candidates from that batch. Unknown JSON
fields and unknown or duplicate candidate IDs are rejected. Selected entries
need a reason of 1 to 280 characters, confidence between 0.7 and 1, a language,
one advertised topic and a reward tier of 21, 100 or 500 sats. The server applies
its own admission, history, topic and budget checks under the storage lock.

The response contains `run_id`, `mode`, `published`, `proposed` and `rejected`
(each rejection has `note_id` and `reason`). Dry-run results only fill `proposed`;
they never create a public placement or invoice. Repeating the same run and
payload returns its original result, including after pause or batch expiry.
Conflicting replay returns 409. The pilot retains at most 512 permanent compact
run records; reaching that capacity blocks new runs while preserving replay.
When human review is enabled (the default), active-fund selections also fill
`proposed` and wait in the private review queue. They are absent from public
feeds and the wallet worker until approval.

`GET /api/curator/status` returns the mode, dry-run start and completed-day count,
pilot timestamps, spending eligibility, reserved principal sats, record counts,
policy and partial collection outcomes. `recent_proposals` contains up to 21
dry-run originals and editorial reasons for private review, without payment
credentials or invoice records. Network coverage describes the selected public
sources only; successful queries do not establish network-wide completeness.
The status also reports `review_required` and `pending_reviews`.

`GET /api/admin/curator/review?offset=0` uses **CURATOR_REVIEW_TOKEN**, a scoped
reviewer credential different from both agent and general admin credentials.
It returns `review_required`, `mode`, `spending_allowed`, daily limits,
`pending_count`, `offset` and up to 21 `items`. Each item includes `note_id`,
`review_id`, the complete signed `event`, reason, topic, language, confidence,
`reward_sats`, creation/expiry timestamps, and `dry_run` and `published` flags.
It excludes invoices, wallet identities and payment-attempt records.

`POST /api/admin/curator/review` accepts one of:

```json
{"action":"set_review","review_required":true}
```

```json
{"action":"approve","note_id":"<event ID>","review_id":"<proposal ID>","reward_sats":100}
```

```json
{"action":"reject","note_id":"<event ID>","review_id":"<proposal ID>"}
```

Approval binds the exact proposal and amount, rechecks current eligibility and
budgets, and atomically admits the original and its pending reward. Repeated
identical approvals or rejections return the existing result; conflicting or
expired decisions return 409. Dry-run approval only marks the private proposal
reviewed, even if the fund has subsequently been activated. New proposals expire
after seven days; active review records are bounded to 100 and retained for up
to 30 days. Turning review off does not release queued proposals. Turning it on
also gates unattempted automatic rewards; already started payments are still
reconciled. The reviewer cannot activate the fund. Unknown fields are rejected.

`POST /api/admin/curator` uses **ADMIN_TOKEN**, not CURATOR_TOKEN, and accepts
`{"mode":"disabled"}`, `{"mode":"dry_run"}` or `{"mode":"active"}`.
Initial activation requires seven distinct UTC days with completed nonempty
dry-run decisions, at least seven elapsed days, a persistent relay identity,
valid separate curator credentials and a configured reward-wallet connection.
Activation establishes one durable 30-day pilot deadline. Pause, resume and
restart do not extend it; an expired pilot cannot be reactivated through this API.

Malformed requests return 400, invalid credentials 401, mode/policy/replay
conflicts 409, expired batches 410, and initialization failure 503. Failed
storage writes do not admit a discovery or start a payment. Mode changes stop
new sends; they cannot cancel an already initiated wallet payment.
