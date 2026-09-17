# Run your own board with Docker

Docker runs the website and relay together. You do not need to install Node.js
or Go. This setup creates your own board, with its own identity and data.

## Before you start

1. Install [Docker Desktop](https://docs.docker.com/get-started/get-docker/)
   and open it. Wait until it says the engine is running. On a Linux server,
   Docker Engine with the Compose plugin also works.
2. Download this repository and open a terminal in its main folder, the one
   containing `README.md` and `compose.yaml` (not the `docs/` folder).
3. Make a copy of `.env.example` named `.env` in that folder. Files beginning
   with a dot may be hidden in your file browser. On macOS or Linux, you can run:

   ```bash
   cp .env.example .env
   ```

Keep this `.env` separate from the settings in `relay/` and `web/`. Docker
reads the one in the main folder. Treat it as private: it will contain the
relay's secret key and, when connected, access to its wallet.

## Create your board's identity

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

## Start the website

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

## Connect a wallet for real payments

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

## Stop, start and check the board

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

## Back up and restore

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

## Update

Make a backup first. Download the new project version into the same folder
while keeping `.env`, or run `git pull` if you downloaded it with Git. Then run:

```bash
docker compose up --build -d --wait
```

Keep the project folder's name and location the same. Compose uses the folder
name to identify its volume; a different name can start a separate, empty board.
Updating from a downloaded archive also requires keeping your `backups` folder.

## Common problems

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

## Put the board on the internet

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
