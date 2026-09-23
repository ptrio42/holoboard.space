# Holoboard relay

A Go relay built on [khatru](https://github.com/fiatjaf/khatru). It serves paid
Nostr notes (kind 1) and comments (kind 1111), processes promotions and computes
the board ranking. See the [project README](../README.md) for product rules.

## Run locally

Use Go 1.23.1 or newer, matching the toolchain in [go.mod](go.mod). Run from
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

Zaps additionally need a resolvable Lightning address in the relay's Nostr
profile, its NWC connection or `ZAP_LNURL_ADDRESSES`. Receipts must be signed by
the LNURL server receiving the payment.

## API and ranking

The [HTTP API reference](API.md) covers preview, invoices, payment status,
rankings, expired promotions and operator removal. Creating an invoice requires
no Nostr key. Billboard purchases use this API.

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
- Send `PROMOTE <note_id>` to the relay by DM to receive an invoice.

These flows add ranking weight and preserve any active billboard appearance.
They do not purchase a new appearance.

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

Entry points: `main.go` for startup, `relay.go` for Nostr handlers,
`storage.go` for persistence and ranking, `payment.go` for zaps,
`lightning.go` for wallets, and `promote_api.go` / `billboard.go` for invoice
promotions and appearance.
