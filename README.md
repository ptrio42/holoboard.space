# holoboard.space

A paid bulletin board for Nostr notes and comments. Anyone can promote a post,
including someone else's. Visit [holoboard.space](https://holoboard.space) to
browse the board or promote a note.

See the [changelog](CHANGELOG.md) for user-facing updates.

## How the board works

Promotion payments determine rank. Each payment loses half its ranking weight
every 30 days, so recent payments count for more. Notes leave the board when
their remaining weight rounds to zero sats.

**Boost** adds another payment to an active note. **Expired** shows past
promotions; **Promote again** brings one back after payment. A payment increases
weight without guaranteeing a particular position.

## Promote a note

Open **Promote**, paste a note link, `note1`, `nevent1` or event ID, choose
the amount and pay the Lightning invoice. No login or signer is needed.

From a Nostr client, you can also mention Holoboard with a promotion command
and zap its reply, zap the account with the note reference in the comment, or
DM `PROMOTE <amount> <note>` to receive an invoice. The full command options
are in the [relay README](relay/README.md#promotion-through-nostr).

Use **Load note & preview** to check the content and optionally choose a
billboard appearance before paying. The payment result confirms your specific
invoice.

When a note is promoted for the first time, the Holoboard Nostr account
publishes one quote labelled as a paid promotion. Boosts and later returns to
the board do not create more quotes. Removing the note from Holoboard publishes
a [NIP-09 deletion request](https://github.com/nostr-protocol/nips/blob/master/09.md)
for that quote, although Nostr cannot guarantee that every relay and client
removes its copy.

The payment form can optionally send a confirmation DM to an npub. DM and
public-command promotions receive a confirmation automatically. Reply directly
to that DM with `YES` to request one notification when the promotion moves to
**Expired**. If your client cannot reply to a specific DM, send
`NOTIFY <note id>` instead. A later revival needs fresh consent.

Promotions are also available through the [relay API](relay/API.md) and Nostr
messages described in the [relay README](relay/README.md#promotion-through-nostr).

## Billboard appearance

Choose LED, neon, image + LED, terminal, split-flap, glitch, poster or slides
from the template gallery, then adjust color, text size and available controls.
The free preview shows the appearance at desktop or phone width. It does not
predict rank.

Highlight a fragment in the original note to choose billboard text, with a total
limit of 160 characters.
Slides use up to three fragments and change every three seconds. Animations
pause on hover or tap and respect reduced-motion settings.
Images also come from that note. Links and quoted-note previews stay visible
below it. **Full note** opens the original content.

Appearance costs an **introductory 100 sats**, deliberately low and subject to
an increase. This fee is separate from the promotion amount and adds no ranking
weight when used for appearance.

Choose appearance when starting a promotion period. Once paid, the appearance
stays fixed while the note remains active, including the standard look. Anyone
can boost it without changing its appearance. After expiry, a new promotion
can purchase billboard appearance again.

If the chosen appearance is no longer available when payment settles, its fee
adds ranking weight instead. The payment result reports this. A payment cannot
restore a note removed by the operator.

## Run your own board with Docker

Install [Docker](https://docs.docker.com/get-started/get-docker/) and run these
commands from the repository's main folder:

```bash
cp .env.example .env
docker compose run --build --rm --no-deps relay /app/keygen
```

Copy the printed `RELAY_PRIVKEY` and `VITE_RELAY_PUBKEY` lines into `.env`, then
start the board:

```bash
docker compose up --build -d --wait
```

Open http://localhost:8080. The default mock backend creates fake invoices that
cannot be paid. Keep `.env` private and reuse the keys after updates.

The [self-hosting guide](docs/self-hosting.md) covers real payments, backups,
updates, troubleshooting and public hosting.

## Development

- [web/](web/README.md): React frontend, setup, configuration and checks.
- [relay/](relay/README.md): Go relay, payment processing and storage.
- [Android release guide](docs/android-release.md): build and publish the Zapstore app.
- [HTTP API](relay/API.md): integration reference for other clients.

## Nostr interoperability

Original signed notes and comments remain readable through Nostr. Exact ranks,
payment weights and billboard settings intentionally use the public HTTP API
for now. Other interfaces can use it without Holoboard UI; Nostr alone does not
yet expose those data.

A separate follow-up will evaluate existing NIPs and define how to publish board
membership, ranking and appearance through Nostr without changing the original
notes. No custom event kind is introduced for billboards in this version.
