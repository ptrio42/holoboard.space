# holoboard.space

A pay-to-promote bulletin board on Nostr. Anyone can pay sats to push a kind:1 note onto the board, and the board is ranked purely by how many sats a note has collected. Payment is the only way in; the relay stores nothing that has not been paid for.

Two parts live here:

```
web/     React + Vite frontend (holoboard.space)
relay/   Go relay built on khatru (relay.holoboard.space)
```

## web

React 19, Vite 7, Tailwind 4, NDK for Nostr. Subscribes to the relay and renders whatever the relay decides to serve, so the ranking logic stays entirely server side. Sign in with a NIP-07 extension and it walks flow 1 for you: it publishes the mention, waits for the relay's reply and zaps it, showing the invoice as a QR and watching for the receipt.

```bash
cd web && npm install && npm run dev
```

Relay URL, relay pubkey and the public relay list all come from `VITE_`-prefixed environment variables; see `web/.env.example`. The defaults are this deployment, so a fresh clone needs no setup.

## relay

Go 1.22+, khatru, go-nostr. Accepts kind:1 only, serves them sorted by total sats paid, then by last payment time, then by age. Beyond serving queries it also runs three outbound subscriptions against public relays: one for zap receipts addressed to it, one for NIP-04 DMs carrying `PROMOTE` commands, and one for mentions of its own pubkey.

```bash
cd relay
cp .env.example .env    # then fill in RELAY_PRIVKEY and a Lightning backend
make run                # or: go run .
make test
```

`LIGHTNING_BACKEND` picks between `mock`, `nwc`, `lnbits` and `zebedee`. Without it the relay boots on the mock backend and generates fake invoices.

`nwc` is the one to reach for. It speaks [NIP-47](https://github.com/nostr-protocol/nips/blob/master/47.md) plus the [NWC-02](https://github.com/nostr-wallet-connect/nwc/blob/master/02.md) notification extension, so the same three calls work against any NWC wallet and changing provider means changing `NWC_URI` rather than changing code. NWC sits between the relay and its own wallet; whoever pays still just pays an ordinary bolt11 and never touches Nostr.

Settlement is picked up two ways. A wallet that advertises `payment_received` pushes notifications the moment an invoice is paid. Everything else is caught by the reconciler, which walks the pending invoices on boot and then on `INVOICE_CHECK_SECONDS`, so invoices paid while the relay was down still get booked.

Runtime state is a single JSON file (`relay_data.json`, path configurable via `DATA_FILE`). It is gitignored, as is `.env`.

## Promotion flows

1. **Zap a promotional reply.** Mention the relay's pubkey in a note containing a note ID. The relay fetches that note, replies with a preview, and records the reply-to-note mapping. Zapping the reply promotes the note.
2. **Zap the relay directly** with the note reference in the zap comment, or in the bolt11 description.
3. **DM `PROMOTE <note_id>`** to the relay and it answers with a Lightning invoice.

## Status

Dormant since February 2026. Before picking it back up:

- Nothing is deployed. The Fly.io app `nostr-promotion-relay` no longer exists, and `relay.holoboard.space` still points a CNAME at a hostname that does not resolve.
- Flow 3 works on the `nwc` backend and is untested against live LNbits or Zebedee. `WatchInvoices` on those two is still a stub that emits nothing, but the reconciler now calls their `CheckInvoice`, so settlement should be detected there too. `EnableWebhooks` remains dead code; it registers on `http.DefaultServeMux` while khatru serves its own handler, so it would need moving to `relay.Router()` to do anything.
- The 36 entries in `pending_invoices` predate all of this and carry no `expires_at`, which reads as long expired. The hourly cleanup will drop them the first time the relay runs. Copy `relay_data.json` before starting it if that matters.
- Zap receipts are not authenticated. `ValidateZapEvent` checks that the `p`, `bolt11` and `description` tags exist and stops there, so a forged kind:9735 event buys arbitrary ranking for free. NIP-57 Appendix F describes the check that is missing.
- The relay never publishes its own kind:0. The profile carrying `lud16` was posted by hand, and nothing in the relay keeps it in step with `LIGHTNING_BACKEND`. Point `NWC_URI` at a different wallet and every zap still goes to the old address.
