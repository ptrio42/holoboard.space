# Holoboard web

The React frontend for [holoboard.space](https://holoboard.space), built with
Vite, Tailwind CSS and NDK. See the [project README](../README.md) for promotion
and billboard rules.

## Run locally

Run from `web/` with Node.js and npm installed:

```bash
npm install
npm run dev
```

Defaults connect to the live Holoboard relay. To use your own relay, copy
[.env.example](.env.example) to `.env.local` and edit its settings.

## Check changes

```bash
npm run test
npm run lint
npm run build
```

The build checks TypeScript and creates the production website in `dist/`.
The development server does not check types.

## Configuration

| Variable | Purpose |
| --- | --- |
| `VITE_RELAY_URL` | Board relay WebSocket URL. |
| `VITE_RELAY_PUBKEY` | Board identity, used for promotion mentions and zaps. |
| `VITE_PUBLIC_RELAYS` | Comma-separated relays for profiles, quoted notes, mentions and zaps. |
| `VITE_BOARD_LIMIT` | Maximum number of board notes requested. Default: 50. |
| `VITE_SATS_ENDPOINT` | Optional board API URL. Defaults to the relay URL over HTTP(S), followed by `/api/board`. |

These settings are included at build time. Rebuild to change a deployed website.

## Where things live

- `src/config.ts`: relay URLs, identity and defaults.
- `src/pages/Billboard.tsx`: board and expired promotions.
- `src/components/BoardRow/`: ranked note cards.
- `src/components/BillboardScreen/`: shared billboard display for preview and feed.
- `src/components/PromoteModal/`: invoice, preview and zap flows.
- `src/components/TextRenderer/`: note content, links and quote previews.
- `src/components/ui/` and `src/index.css`: shared controls and styles.

Notes come from the board relay through Nostr. The app reads ranks, payment
weights and appearance from its [HTTP API](../relay/API.md), refreshing every
15 seconds. Public-relay notes do not enter the board subscription. Ranking
and payment decisions belong to the relay.

## Visual conventions

Use the pixel font for headings, controls and ranks; note bodies use a system
monospace font. Card frames show rank: gold, cyan and pink for the top three,
then dim cyan. Paid billboard text has its own selected color inside that frame.

[Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P), by CodeMan38,
is bundled as WOFF2 under the SIL Open Font License 1.1.
