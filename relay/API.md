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
`images`. Preview does not create an invoice or board entry. Fetching is rate
limited; unpaid previews are cached in memory for one minute, up to 128 entries.

## Create an invoice

`POST /api/promote`

```json
{"note": "<note reference>", "amount_sats": 1000}
```

Omitting `amount_sats`, or passing zero for an ordinary promotion, uses
`DEFAULT_PAYMENT_SATS`. The response includes `invoice`, `payment_hash`,
`note_id`, `expires_at` (Unix seconds), total `amount_sats`, `promotion_sats` and
`billboard_fee_sats`.

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
