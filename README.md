# holoboard.space

A pay-to-promote bulletin board on Nostr. Anyone can pay sats to push a kind:1 note onto the board, and the board is ranked purely by how many sats a note has collected. Payment is the only way in; the relay stores nothing that has not been paid for.

Two parts live here:

```
web/     React + Vite frontend (holoboard.space)
relay/   Go relay built on khatru (relay.holoboard.space)
```

## Run your own board with Docker

Docker runs the website and relay together. You do not need to install Node.js
or Go. This setup creates your own board, with its own identity and data.

### Before you start

1. Install [Docker Desktop](https://docs.docker.com/get-started/get-docker/)
   and open it. Wait until it says the engine is running. On a Linux server,
   Docker Engine with the Compose plugin also works.
2. Download this repository and open a terminal in its main folder, the one
   containing this README and `compose.yaml`.
3. Make a copy of `.env.example` named `.env` in that folder. Files beginning
   with a dot may be hidden in your file browser. On macOS or Linux, you can run:

   ```bash
   cp .env.example .env
   ```

Keep this `.env` separate from the settings in `relay/` and `web/`. Docker
reads the one in the main folder. Treat it as private: it will contain the
relay's secret key and, when connected, access to its wallet.

### Create your board's identity

Run this once:

```bash
docker compose run --build --rm --no-deps relay /app/keygen
```

The first run downloads tools and builds the relay, so it can take several
minutes. It prints two lines beginning with `RELAY_PRIVKEY=` and
`VITE_RELAY_PUBKEY=`. Open `.env` in a text editor and replace its two empty
lines with the printed lines. Save the file.

The private key controls your board's identity; the public key tells the website
which relay it belongs to. Keep the pair together and reuse it after updates.
Do not share the private key or generate a new pair every time you start.

### Start the website

```bash
docker compose up --build -d --wait
```

Open **http://localhost:8080** in your browser. The first startup may take a
minute while the relay connects to Nostr. A new board starts with a welcome
note; posts from the public holoboard deployment are not copied into it.

The default setting, `LIGHTNING_BACKEND=mock`, lets you try the interface.
Its invoices are fake and cannot be paid. To receive real payments, follow
the wallet steps below.

The website is available only on your computer by default. Keep Docker running
while using it. Closing the terminal does not stop the board.

### Connect a wallet for real payments

In a wallet that supports Nostr Wallet Connect (NWC), create a connection for
this board with permission to create invoices, look up invoices and read wallet
information. Enable payment notifications if your wallet offers them.

Open `.env` and set:

```dotenv
LIGHTNING_BACKEND=nwc
NWC_URI=your_wallet_connection_string
```

Paste the complete connection string supplied by your wallet, beginning with
`nostr+walletconnect://`. Apply the change:

```bash
docker compose up -d --wait
```

Use the website's Promote dialog to request an invoice for a Nostr note, pay it,
and wait for the note to appear. Invoice promotion works without a Nostr profile
for the relay. Direct zaps additionally need a Lightning address in its Nostr
profile, pointing to the wallet receiving them.

### Stop, start and check the board

Run these commands from the same main folder:

| What you want to do | Command |
| --- | --- |
| Stop the board and keep its data | `docker compose down` |
| Start it again | `docker compose up -d --wait` |
| Check whether it is running | `docker compose ps` |
| Read recent relay messages | `docker compose logs --tail=100 relay` |
| Follow relay messages as they happen | `docker compose logs -f relay` |

Press Ctrl+C to stop following messages. This leaves the board running.

Board data is kept in a Docker volume, separate from the containers. Stopping
or rebuilding the containers keeps that volume. **Do not add `--volumes` or
`-v` to `docker compose down`: that deletes the board's data.** Docker Desktop's
volume deletion and factory reset can also remove it.

### Back up and restore

Back up both the board data and `.env`. On macOS or Linux:

```bash
mkdir -p backups
docker compose stop relay
docker compose cp relay:/data/relay_data.json backups/relay_data.json
cp .env backups/settings.env
docker compose up -d --wait
```

Stopping the relay briefly makes the copy consistent. These commands replace
the previous backup with the current one. Store another copy somewhere safe,
separate from this computer. The settings backup contains secrets.

To restore, first place the settings backup back in the main folder as `.env`.
If the containers have been removed, create them with `docker compose create
--build`. Then run:

```bash
docker compose stop
docker compose cp backups/relay_data.json relay:/data/relay_data.json
docker compose run --rm --no-deps --user root relay sh -c 'chown relay:relay /data/relay_data.json && chmod 600 /data/relay_data.json'
docker compose up --build -d --wait
```

Restoring replaces the current board with the backup. Keep a backup of the
current data before restoring an older copy.

### Update

Make a backup first. Download the new project version into the same folder
while keeping `.env`, or run `git pull` if you downloaded it with Git. Then run:

```bash
docker compose up --build -d --wait
```

Keep the project folder's name and location the same. Compose uses the folder
name to identify its volume; a different name can start a separate, empty board.
Updating from a downloaded archive also requires keeping your `backups` folder.

### Common problems

- **Docker cannot connect to the engine:** open Docker Desktop and wait for it
  to finish starting.
- **The `.env` file is missing:** copy the main folder's `.env.example` and
  check that your editor did not name the copy `.env.txt`.
- **The relay asks for keys:** complete the identity step and save both values
  in `.env` before starting.
- **Port 8080 is already in use:** set `WEB_PORT=8081` and
  `VITE_RELAY_URL=ws://localhost:8081/relay` in `.env`, then run the update
  command. Open http://localhost:8081 instead.
- **The website says the relay is unavailable:** run `docker compose ps` and
  check the relay messages with the command above.
- **An invoice cannot be paid:** check that the backend is `nwc`, not `mock`.
  If an NWC payment remains pending, check the wallet connection and logs.

### Put the board on the internet

The local setup uses HTTP. A public deployment needs a domain and HTTPS, usually
provided by a reverse proxy on a server that stays on. Configure that proxy to
forward HTTP requests and WebSocket upgrades to the website container on port
8080. It serves the relay at `/relay` and its APIs under `/relay/api/`.

For a website at `https://board.example.com`, set
`VITE_RELAY_URL=wss://board.example.com/relay` and update `RELAY_DESCRIPTION`
with your website URL in `.env`. Rebuild with the update command. The `VITE_`
settings are included when the website is built; restarting alone cannot
change them. [Vite explains this here](https://vite.dev/guide/env-and-mode).

If your reverse proxy runs on the same host, it can use the default
`127.0.0.1:8080` address. A proxy in another container needs a shared Docker
network. Change `WEB_BIND_ADDRESS` only if your hosting setup requires it.

If you want a NIP-05 name for your board, update
`web/public/.well-known/nostr.json` with your public key and public relay URL
before building. The included document belongs to the public holoboard
deployment. The Docker website serves this path with the CORS header needed
by Nostr clients.

Run **one relay instance continuously**. It watches external relays for payments,
messages and mentions. Multiple instances cannot safely share its JSON storage.

## web

React 19, Vite 7, Tailwind 4, NDK for Nostr. Subscribes to the relay and renders whatever the relay decides to serve, so the ranking logic stays entirely server side. Sign in with a NIP-07 extension and it walks flow 1 for you: it publishes the mention, waits for the relay's reply and zaps it, showing the invoice as a QR and watching for the receipt.

```bash
cd web && npm install && npm run dev
```

Relay URL, relay pubkey and the public relay list all come from `VITE_`-prefixed environment variables; see `web/.env.example`. The defaults are this deployment, so a fresh clone needs no setup.

## relay

Go 1.22+, khatru, go-nostr. Accepts kind:1 notes and kind:1111 comments, and serves them ordered by what their payments are worth today: each payment halves in weight every thirty days, so a note nobody pays for slides down rather than sitting on a total it earned once. Beyond serving queries it also runs three outbound subscriptions against public relays: one for zap receipts addressed to it, one for NIP-04 DMs carrying `PROMOTE` commands, and one for mentions of its own pubkey.

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

Notes disappear from the board when their current weight rounds to zero sats.
Their payment history stays in storage, and a new payment makes them visible
again. An open website removes expired notes on its next ledger refresh.

Use **Boost** below an active note to add another payment. The **Expired** link
below the board opens past promotions, where **Promote again** brings a note
back after payment. Both buttons fill in the note reference; choose an amount
and request an invoice when ready. A payment adds weight but does not guarantee
a particular rank. Notes removed by the operator are excluded from the archive.
The archive is also available at `GET /api/board/expired`, with optional `limit`
(1 to 50) and `cursor` parameters. Use the returned `next_cursor` for another page.

## Promotion flows

1. **Pay an invoice, no key needed.** `POST /api/promote` with a note reference and an optional `amount_sats`; the relay answers with a bolt11. `GET /api/promote/status` says whether that invoice is still outstanding and what the note has collected, which is how a caller tells settlement from expiry: both leave storage the same way. The reference can be a `note1`, an `nevent1`, a bare 64-character id, or a link containing one. Crediting comes from the payment rather than from whoever asked, so nothing here needs a signer. This is what the website's promote dialog uses by default.
2. **Zap a promotional reply.** Mention the relay's pubkey in a note containing a note ID. The relay fetches that note, replies with a preview, and records the reply-to-note mapping. Zapping the reply promotes the note.
3. **Zap the relay directly** with the note reference in the zap comment, or in the bolt11 description.
4. **DM `PROMOTE <note_id>`** to the relay and it answers with a Lightning invoice.
