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

1. **Pay an invoice, no key needed.** `POST /api/promote` with a note reference and an optional `amount_sats`; the relay answers with a bolt11. `GET /api/promote/status` says whether that invoice is still outstanding and what the note has collected, which is how a caller tells settlement from expiry: both leave storage the same way. The reference can be a `note1`, an `nevent1`, a bare 64-character id, or a link containing one. Crediting comes from the payment rather than from whoever asked, so nothing here needs a signer. This is what the website's promote dialog uses by default.
2. **Zap a promotional reply.** Mention the relay's pubkey in a note containing a note ID. The relay fetches that note, replies with a preview, and records the reply-to-note mapping. Zapping the reply promotes the note.
3. **Zap the relay directly** with the note reference in the zap comment, or in the bolt11 description.
4. **DM `PROMOTE <note_id>`** to the relay and it answers with a Lightning invoice.
