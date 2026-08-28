# holoboard.space

A pay-to-promote bulletin board on Nostr. Anyone can pay sats to push a kind:1 note onto the board, and the board is ranked purely by how many sats a note has collected. Payment is the only way in; the relay stores nothing that has not been paid for.

Two parts live here:

```
web/     React + Vite frontend (holoboard.space)
relay/   Go relay built on khatru (relay.holoboard.space)
```

## web

React 19, Vite 7, Tailwind 4, NDK for Nostr. Subscribes to the relay and renders whatever the relay decides to serve, so the ranking logic stays entirely server side.

```bash
cd web && npm install && npm run dev
```

The relay URL is hardcoded in `src/components/Ndk.tsx`.

## relay

Go 1.22+, khatru, go-nostr. Accepts kind:1 only, serves them sorted by total sats paid, then by last payment time, then by age. Beyond serving queries it also runs three outbound subscriptions against public relays: one for zap receipts addressed to it, one for NIP-04 DMs carrying `PROMOTE` commands, and one for mentions of its own pubkey.

```bash
cd relay
cp .env.example .env    # then fill in RELAY_PRIVKEY and a Lightning backend
make run                # or: go run .
make test
```

`LIGHTNING_BACKEND` picks between `mock`, `lnbits` and `zebedee`. Without it the relay boots on the mock backend and generates fake invoices.

Runtime state is a single JSON file (`relay_data.json`, path configurable via `DATA_FILE`). It is gitignored, as is `.env`.

## Promotion flows

1. **Zap a promotional reply.** Mention the relay's pubkey in a note containing a note ID. The relay fetches that note, replies with a preview, and records the reply-to-note mapping. Zapping the reply promotes the note.
2. **Zap the relay directly** with the note reference in the zap comment, or in the bolt11 description.
3. **DM `PROMOTE <note_id>`** to the relay and it answers with a Lightning invoice.

## Status

Dormant since February 2026. Before picking it back up:

- Nothing is deployed. The Fly.io app `nostr-promotion-relay` no longer exists, and `relay.holoboard.space` still points a CNAME at a hostname that does not resolve.
- Flow 3 never completes. `WatchInvoices` is a stub in both the LNbits and Zebedee backends, `CheckInvoice` has no callers, and `EnableWebhooks` is never called from `main.go`, so a paid invoice is never noticed. The 36 entries in `pending_invoices` are the evidence.
- Zap receipts are not authenticated. `ValidateZapEvent` checks that the `p`, `bolt11` and `description` tags exist and stops there, so a forged kind:9735 event buys arbitrary ranking for free. NIP-57 Appendix F describes the check that is missing.
- The frontend has no way to pay. "ADD AD" opens instructions telling the reader to go zap from another client. There is no NIP-07 login and no zap button.
