# Deploying the relay

Fly.io, one machine, one volume. The frontend is not deployed from here; see
the [frontend README](../web/README.md) for its build and configuration.

To run both parts together with Docker Compose, follow the
[self-hosting guide](../docs/self-hosting.md).
Compose builds the non-root `standalone` image target. Fly builds the default
`fly` target, which preserves `/root/data` and access to the existing volume.

## What you need first

- `flyctl`, and `fly auth login` on the account that will own the app
- A wallet connection string for `NWC_URI` (any NWC wallet; Coinos is free and
  needs no ID)
- The relay's nostr private key for `RELAY_PRIVKEY`

That key is the board's identity. Its pubkey is baked into the frontend as the
default `RELAY_PUBKEY` in `web/src/config.ts`, and it is the key the relay's
nostr profile and its `lud16` hang off. Deploy without setting it and the relay
generates a fresh one at boot, logs a warning, and quietly becomes a different
relay: every zap and mention aimed at the old pubkey stops being heard.

## Why this machine never sleeps

`fly.toml` sets `auto_stop_machines = 'off'` and `min_machines_running = 1`, so
it runs around the clock and is billed around the clock. That is deliberate.

The relay's real work is outbound. It holds subscriptions to public relays,
watching for zap receipts, DMs and mentions. Fly wakes a sleeping machine on an
incoming request, and nobody sends this relay a request when someone zaps it on
nos.lol. Scale-to-zero would cut the bill to nearly nothing and break the
product.

## First deploy

```bash
cd relay

fly apps create holoboard-relay          # or edit `app` in fly.toml first
fly volumes create relay_data --size 1 --region fra

fly secrets set RELAY_PRIVKEY=... NWC_URI=...   # one command, one restart

fly deploy
fly logs
```

Set both secrets in a single `fly secrets set`. Each invocation restarts the
app, and setting them one at a time means the relay boots once with half its
configuration and exits.

In the logs you are looking for:

```
Relay pubkey: 30bd172f...          <- must match web/src/config.ts
Using NWC Lightning backend via wss://relay.coinos.io
NWC: wallet supports methods [...], notifications [payment_received ...]
Board ledger served at /api/board
Relay is listening on port 8080
```

If the pubkey line does not match what the frontend expects, stop: the wrong
`RELAY_PRIVKEY` went in.

## Updating the existing deployment

The relay and HTTP API are one Go application, deployed together on Fly.
The website is deployed separately on Cloudflare Pages.

Deploy the backend before publishing a frontend that uses new API fields or
billboard templates. From the repository root:

```bash
cd relay
fly status -a holoboard-relay
fly config validate
fly deploy
fly status -a holoboard-relay
curl --fail https://relay.holoboard.space/api/board
```

Back up the ledger before deploying, using the command below. Keep the existing
volume and secrets; updating code does not require recreating either.
Updates preserve the existing machine count. Fly also creates only one machine
on initial deployment when a volume is mounted, so `--ha=false` is optional for
this configuration. Keep one running instance for this ledger. See Fly's
[scaling rules](https://fly.io/docs/launch/scale-count/) and
[initial redundancy rules](https://fly.io/docs/apps/app-availability/).

## Restoring the board

A fresh volume is an empty board. The relay will notice it has no info event
and publish a new one, so upload the existing state before letting it settle:

```bash
fly ssh sftp shell
put relay_data.json /root/data/relay_data.json
fly apps restart holoboard-relay
```

Restore the complete ledger, including `pending_invoices` and settlement
receipts. Pending invoices are retained so delayed payments can still be
credited; expiry alone does not prove an invoice was never paid. Do not clear
them during a deployment or restore. Unpaid invoices can accumulate because
the wallet lookup does not provide a definitive unpaid result.

Back it up the same way, in reverse:

```bash
fly ssh sftp get /root/data/relay_data.json ./relay_data.backup.json
```

There is no other copy. The volume is the only place this state lives.

## Custom domain

DNS for holoboard.space is managed in Cloudflare. Two names matter, and they
point at different things:

| Name | Serves | Record |
| --- | --- | --- |
| `relay.holoboard.space` | the Go relay, on Fly | CNAME to whatever `fly certs add` prints |
| `holoboard.space` | the static frontend | whatever the static host asks for |

### The relay

```bash
fly certs add relay.holoboard.space
```

It prints the record to create. The target changes whenever the app is
recreated or moved to another account, so read it rather than reusing an old
one, then:

```bash
fly certs check relay.holoboard.space
```

A CNAME left pointing at an app that no longer exists resolves to nothing, and
the frontend then shows "relay is down" with no other clue. That is exactly what
happened between February and August 2026.

### The frontend, and why the apex is not optional

The production UI uses the Cloudflare Pages project `holoboard-space`, connected
to `ptrio42/holoboard.space` on GitHub. Check these settings in its dashboard:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | `web` |
| Build command | `npm ci && npm run build` |
| Build output directory | `dist` |

These are the intended production settings; the Cloudflare project
configuration is managed outside Git. See the [Pages build configuration
reference](https://developers.cloudflare.com/pages/configuration/build-configuration/).
With [Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/)
and automatic deployments enabled, pushing the production branch publishes
the UI. Verify the backend first, then push and check the Pages build result.

The `VITE_*` settings in the [frontend README](../web/README.md#configuration)
are compiled into the website. Check production overrides in Cloudflare,
especially the relay URL and public key. Repository defaults point to the
production relay; local development overrides must not be used for publishing.

The apex has to be the frontend rather than a redirect, because
`web/public/.well-known/nostr.json` is the NIP-05 document for `_@holoboard.space`.
Clients fetch `https://holoboard.space/.well-known/nostr.json?name=_` directly,
so a redirect or a www-only setup breaks the identifier.

`web/public/_headers` sets `Access-Control-Allow-Origin: *` on `/.well-known/*`,
which both Cloudflare Pages and Netlify honour. Without it the lookup is a
cross-origin fetch the browser blocks, and the identifier fails to verify with
no visible error.

Manage production DNS in Cloudflare. An ordinary code update does not require
changing DNS records or recreating either custom-domain binding.

## Do not scale out

`fly scale count 2` will corrupt the payment ledger.

State lives in one JSON file on one volume, held in memory behind one mutex. A
second machine gets its own volume and its own copy, both accept payments, and
neither ever learns about the other's. Whichever writes last wins, and the sats
in between are gone. Growing past one machine means moving storage out of the
process first.

Vertical scaling is fine:

```bash
fly scale vm shared-cpu-1x --memory 512
```

## Configuration

Non-secret settings live in `[env]` in `fly.toml` and take effect on the next
`fly deploy`:

| Variable | What it does |
| --- | --- |
| `DATA_FILE` | Ledger path. Must sit under the mounted volume, `/root/data`. |
| `PORT` | Must match `internal_port`. |
| `LIGHTNING_BACKEND` | `nwc`, `mock`, `lnbits` or `zebedee`. Only `nwc` and `mock` are exercised. |
| `INVOICE_CHECK_SECONDS` | How often to re-check invoices still waiting. |
| `DEFAULT_PAYMENT_SATS` | Invoice amount when a `PROMOTE` DM names none. |
| `FETCH_RELAYS` | Public relays watched for zaps and mentions, and used to fetch notes. |
| `DM_RELAYS` | Optional NIP-17 inbox relays read and advertised by the service. |
| `PUBLIC_BOARD_URL` | Public website linked from paid-promotion quotes. |

Secrets go through `fly secrets set` and never into `fly.toml`: `RELAY_PRIVKEY`
and `NWC_URI`. `fly secrets list` shows names and digests, never values.

Keep `DATA_FILE` under the mounted volume. The Fly image defaults to
`/root/data/relay_data.json`, and `[env]` sets the same path explicitly. When
running the Go binary outside Docker, its fallback is a bare `relay_data.json`
in the working directory.

## Cost

Roughly 2 to 3 USD a month: a `shared-cpu-1x` at 256MB running continuously,
plus about 0.15 for a 1GB volume, plus 2 more if you allocate a dedicated IPv4
that a CNAME does not need. Treat those as estimates from
<https://fly.io/docs/about/pricing/> rather than quotes, and check the current
page. Fly no longer has the free allowance older guides describe.

The previous deploy ran at 1GB for a board holding eleven posts, which was
roughly triple the machine cost for nothing.

## Troubleshooting

**Exits at boot.** Almost always a missing secret: `NWC_URI` unset with
`LIGHTNING_BACKEND=nwc` is a `log.Fatalf`. Check `fly secrets list`.

**Board is empty after a deploy.** Look for `Storage initialized: 0 promoted
posts`. Either the volume did not mount or `DATA_FILE` is pointing off it:

```bash
fly ssh console
ls -la /root/data
```

**Invoices never settle.** Check whether the wallet advertises notifications in
the boot log. If it does not, everything falls to the reconciler's polling and
settles within `INVOICE_CHECK_SECONDS`. If it does and payments still hang, the
notification subscription is the thing to look at.

**Websocket will not connect.** `fly status` first, then `websocat
wss://holoboard-relay.fly.dev`. A working relay answers a REQ; nothing else on
the path does.

## Do not run deploy.sh

It was deleted. It predated the NWC backend, so it prompted for LNbits and
Zebedee keys, and it rewrote `fly.toml` with a `sed` that did not survive the
quoting. The steps above are what it was trying to do.
