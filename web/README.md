# holoboard web

The frontend of [holoboard.space](https://holoboard.space): a bulletin board on Nostr where
rank is total sats paid and nothing else.

The relay does the ranking. It serves the board already ordered, so this app renders the notes
in the order they arrive and adds no sorting of its own. If the relay is unreachable there is
no board, and the page says so rather than showing an empty list.

## Running it

```bash
npm install
npm run dev
```

Defaults point at the production relay, so a fresh clone works with no setup. Copy `.env.example`
to `.env.local` to point somewhere else.

```bash
npm run build   # tsc -b && vite build; this is what typechecks
npm run lint
```

`npm run dev` does not typecheck. Run the build before calling anything done.

## Configuration

| Variable | What it is |
| --- | --- |
| `VITE_RELAY_URL` | The board relay. Serves the ranked list. |
| `VITE_RELAY_PUBKEY` | The relay's identity. Promotions are mentions of, and zaps to, this key. |
| `VITE_PUBLIC_RELAYS` | Where profiles, promotion mentions, the relay's replies and zap receipts travel. |
| `VITE_BOARD_LIMIT` | How many ranked notes to ask for. |

Both relay sets sit in the same NDK pool, because the board relay stores only what has been paid
for and cannot carry the rest. The board subscription pins itself to `VITE_RELAY_URL` with
`exclusiveRelay`, so notes seen on public relays never drift into the ranking.

## Promoting a note

`PROMOTE A NOTE` walks the mention flow, which is the one with real usage:

1. Sign in with a NIP-07 extension.
2. Paste any note reference. `note1`, `nevent1`, a bare 64-character id, or a client URL
   containing one.
3. The app publishes a kind:1 mentioning the relay and quoting that note, to the public relays.
4. The relay answers with a promotional reply carrying a `promoted_note` tag.
5. Zapping that reply is what buys the ranking. The invoice appears as a QR, a copyable bolt11
   and a `lightning:` link; WebLN pays it directly when a wallet is present.

Payment is confirmed by watching for the zap receipt, not by trusting the wallet, so paying from
a phone in another room still closes the loop.

The direct-zap and `PROMOTE` DM routes are behind **Other ways to promote** in the same dialog.

## Layout

```
src/
  components/
    ui/            buttons, panels, modal, avatar, QR, spinner
    BoardRow/      one ranked note
    PromoteModal/  the promotion flow and its state machine
    LoginButton/   NIP-07 sign-in
    Ndk.tsx        headless NDK session wiring
  hooks/           relay connection status
  lib/             the NDK singleton, nostr encoding helpers, time formatting
  pages/           the board
```

## Look

Pixel art, PressStart2P, neon cyan and pink on near-black. Two rules keep it legible:

- **PressStart2P is for display only.** Headings, buttons, labels, rank numbers. Note bodies use a
  system mono, because notes are long and arrive in every script.
- **Colour carries rank, not decoration.** Gold, cyan and pink for the top three, a dim cyan for
  everything below.

The corner notch comes from one `--pixel-notch` clip-path shared by every framed surface. Because
`clip-path` cuts a `border` into disconnected pieces at the corners, framed things are built as two
stacked layers: an outer one in the border colour, an inner one in the panel fill.

Press Start 2P is by CodeMan38, under the SIL Open Font License 1.1
([source](https://fonts.google.com/specimen/Press+Start+2P)), shipped here as WOFF2.
