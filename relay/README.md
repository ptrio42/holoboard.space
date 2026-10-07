# Holoboard relay

A Go relay built on [khatru](https://github.com/fiatjaf/khatru). It serves paid
Nostr notes (kind 1) and comments (kind 1111), processes promotions and computes
the board ranking. See the [project README](../README.md) for product rules.

## Run locally

Use Go 1.27.1 or newer, matching the toolchain in [go.mod](go.mod). Run from
`relay/`:

```bash
cp .env.example .env
go run ./cmd/keygen
```

Put the generated `RELAY_PRIVKEY` in `.env`. If connecting the frontend, use the
printed `VITE_RELAY_PUBKEY` there too. Then start the relay:

```bash
make run
```

The defaults are `ws://localhost:3334`, storage in `relay_data.json` and a mock
Lightning backend. Mock invoices cannot be paid. For the complete website and
relay setup, use the [Docker guide](../docs/self-hosting.md).

## Configuration and payments

[.env.example](.env.example) lists the available settings. The main ones are:

| Variable | Purpose |
| --- | --- |
| `RELAY_PRIVKEY` | Persistent board identity, as a hex private key. Keep it private. |
| `LIGHTNING_BACKEND` | `mock` (default), `nwc`, `lnbits` or `zebedee`. |
| `NWC_URI` | Wallet connection string when using `nwc`. |
| `PORT` | HTTP and WebSocket port. Default: 3334. |
| `DATA_FILE` | JSON storage path. Default: `relay_data.json`. |
| `FETCH_RELAYS` | Relays used to fetch notes and watch mentions and zap receipts. |
| `DM_RELAYS` | NIP-17 inbox relays the service reads and advertises in kind 10050. |
| `PUBLIC_BOARD_URL` | Public website linked from paid-promotion quotes. |
| `DEFAULT_PAYMENT_SATS` | Default invoice amount. Default: 1000. |
| `INVOICE_CHECK_SECONDS` | Pending-invoice polling interval. Default: 60 seconds. |
| `ADMIN_PUBKEY` / `ADMIN_TOKEN` | Optional operator access through DMs / HTTP. |

For real invoices, configure a wallet backend. NWC is the recommended option;
use a connection with invoice creation, invoice lookup and wallet-information
permissions. LNbits and Zebedee adapters are also implemented. LND is not.

Wallet notifications trigger settlement when available. Pending invoices are
also checked at startup and at the configured polling interval, including those
paid while the relay was offline. Unsettled invoice records are retained after
expiry so delayed payment confirmation remains recoverable. Abandoned invoices
therefore accumulate in the data file.

The first successful promotion of a previously unseen note also queues one
[NIP-18](https://github.com/nostr-protocol/nips/blob/master/18.md) kind 1 quote
from the board identity. The signed event and its per-relay
delivery state are stored with the payment, then published to `FETCH_RELAYS`
outside the storage lock. Failed deliveries resume after a restart. Boosts,
revivals and notes already present when this feature is installed are not
quoted. Operator removal queues a
[NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md) kind 5 deletion
request for the quote.

New quotes advertise Holoboard and author recipient weights using
[NIP-57 zap tags](https://github.com/nostr-protocol/nips/blob/master/57.md#appendix-g-zap-tag-on-other-events).
The first settled promotion fixes the split, defaulting to 80% visibility and
20% author support. Boosts and revivals retain it. Existing campaigns without a
saved split default to 100% visibility, including after revival or restart.
Payers can opt into separate author support without changing that campaign
default, its stored metadata or its public quote. A verified zap to the
Holoboard share of the quote credits the original note once; author zaps never
add visibility. Clients that support splits pay each recipient separately.
Each zap tag uses a relay that supplied the recipient's signed kind:0 profile
with a Lightning address. Discovery checks the note source, configured relays
and the recipient's [NIP-65 write relays](https://github.com/nostr-protocol/nips/blob/master/65.md).
It selects the latest valid profile across these sources, with the event-ID
tie break from [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md).
An older address-free cache cannot confirm absence when the advertised write
relays are unavailable. If no profile is found within the bounded
lookup, its relay hint stays empty; both recipients and their weights are kept.
Existing public quotes are never rewritten to update hints or splits.
Confirmed absence of a payment address in the author's signed profile makes a
new campaign visibility only. Failed profile discovery or a temporary wallet
outage preserves the requested split. Preview, invoice creation and the first
public quote apply this distinction; settlement saves the quote's actual split.

Promotional reply mappings retain the original note's relay hints and author
across restarts. When reconstructing a payment target from a relay, the signed
Holoboard reply or quote supplies these hints, with older mention chains as a
fallback.

Zaps additionally need a resolvable Lightning address in the relay's Nostr
profile, its NWC connection or `ZAP_LNURL_ADDRESSES`. Receipts must be signed by
the LNURL server receiving the payment.

## API and ranking

The [HTTP API reference](API.md) covers preview, invoices, payment status,
rankings, the waiting room, author support, expired promotions and operator
removal. Creating an invoice requires no Nostr key. Billboard purchases use
this API.

The main board contains the highest 21 active ranks. The waiting room contains
the remaining active notes, sorted by rank (Top), first promotion (New), or
visibility payments over 24 hours (Hot). New records preserve their first paid
time across boosts and revivals. For older records, New uses the earliest
available payment timestamp; files without payment history use their last paid
time. Existing quotes are not replaced to add split tags.

Author support uses the author's signed kind 0 profile and
[LNURL-pay](https://github.com/lnurl/luds/blob/luds/06.md). The service prepares
invoices from the author's provider and verifies their signature, exact amount,
network and expiry. Ordinary LNURL-pay invoices may use plain descriptions;
public zaps require a hash of the exact signed request. It cannot spend from
the board wallet or forward funds. HTTPS endpoints and up to three redirects
must resolve to public addresses; private networks and nonstandard ports are
rejected. Endpoint details are cached for five minutes.
Profile discovery also checks note relay hints, stored quote sources and the
author's NIP-65 write relays, using the same signed-profile lookup as quotes.
Issued author invoices retain their recipient, invoice digest and provider key
in durable storage. Receipt verification uses that snapshot across restarts,
address changes and provider outages. Older invoices without a snapshot retain
the current-provider fallback; wallet preimages remain independent of profiles.
Optional signed NIP-57 requests produce public zaps. Wallet preimages or verified
zap receipts prove author payment; ordinary external wallet payments without
proof remain unverified. Author support endpoints share a limit of 20 requests
per client address over ten minutes.

Each promotion payment halves in ranking weight every 30 days. Ties use total
promotion sats, then the latest payment and note creation time. Notes expire
when their remaining weight rounds to zero; their history stays available for
promotion again.

Original events are served through Nostr. Exact ranks, weights and appearance
use HTTP intentionally. The planned Nostr transport is described in the
[project README](../README.md#nostr-interoperability).

## Promotion through Nostr

- Mention the relay's public key with the complete command `promote <note_id>`,
  then zap the relay's promotional reply. When quoting the target note, use the
  complete command `promote`.
- Zap the relay directly with the target reference in the zap comment or invoice
  description.
- Send `PROMOTE <note_id>` or `PROMOTE <amount_sats> <note_id>` to the relay by
  DM to receive an invoice in the same conversation.

These flows add ranking weight and preserve any active billboard appearance.
They do not purchase a new appearance.

Private messages use
[NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) kind 14 chat
rumors inside [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md)
gift wraps, encrypted with NIP-44. Legacy NIP-04 kind 4 requests still receive
kind 4 replies. At startup, the service publishes a kind 10050 inbox list to
discovery relays. The default list contains three relays; the monitor also
reads the previously advertised Damus inbox during the transition. A custom
`DM_RELAYS` setting controls both the advertised and read lists. NIP-17 replies
go only to the recipient's own kind 10050 relays; no list means no speculative
fallback delivery.

After a DM invoice or public promotion reply is paid, Holoboard sends a
confirmation DM to the requester. Reply directly to it with `YES`, or send
`NOTIFY <note_id>`, to consent to one notification when the current activity
period moves to Expired. Consent does not carry over after the note is promoted
again. A direct zap has no authenticated requester and therefore creates no
notification offer.

Outgoing messages and their signed event IDs are stored before publication.
Delivery is tracked per relay, failed relays are retried after restarts, and
undeliverable command replies expire from the queue after 24 hours. Replies
without a recipient kind 10050 list are retried after ten minutes. Ordinary
command replies are capped at 100 queued globally and three per sender;
invoices, successful confirmations and promotion notifications are exempt.
NIP-17 keeps a separately wrapped sender copy as required for sent-message
history.

## Storage and deployment

`DATA_FILE` stores promoted events, payment history, pending invoices and
settlement receipts. Back up this file and the relay's private key. Run one relay
instance continuously; multiple instances cannot safely share this JSON file.

Deployment instructions: [Docker](../docs/self-hosting.md) or
[Fly.io](DEPLOYMENT.md).

## Development

```bash
make test
make build
```

Run application tests without cached results and include the locally patched
go-nostr module, which `./...` does not traverse:

```bash
go test -count=1 ./...
go test -count=1 -race ./...
go test -count=1 -race github.com/nbd-wtf/go-nostr
```

Both khatru and go-nostr use local patches for safe concurrent operation. The
go-nostr patch closes sockets and joins connection workers during shutdown;
it fixes the previous `Relay.Close` race in wallet and profile connections.
See the [patch reference](patches/README.md).

Entry points: `main.go` for startup, `relay.go` for Nostr handlers,
`storage.go` for persistence and ranking, `payment.go` for zaps,
`lightning.go` for wallets, `dm_monitor.go` / `nip17.go` for private messages,
and `promote_api.go` / `billboard.go` for invoice promotions and appearance.
