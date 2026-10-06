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

The service validates invoice amount, description hash, network and expiry.
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
