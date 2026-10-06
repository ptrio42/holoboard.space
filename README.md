# holoboard.space

A paid bulletin board for Nostr notes and comments. Anyone can promote a post,
including someone else's. Visit [holoboard.space](https://holoboard.space) to
browse the board or promote a note.

See the [changelog](CHANGELOG.md) for user-facing updates.

## How the board works

Promotion payments determine rank. Each payment loses half its ranking weight
every 30 days, so recent payments count for more. The main board shows the top
21 active notes. Other paid notes appear in the **Waiting room**:

- **Top** follows the same ranking, starting at position 22.
- **New** orders notes by their first paid promotion, without refreshing on a boost.
- **Hot** orders notes by visibility sats paid in the last 24 hours.

Notes move between the board and waiting room as ranks change. They move to
**Expired** when their remaining weight rounds to zero sats. Unpaid notes do not
enter either active view. The minimum visibility payment remains 1 sat.

**Boost** adds another payment to an active note. **Expired** shows past
promotions; **Promote again** brings one back after payment. A payment increases
weight without guaranteeing a particular position.

## Promote a note

Open **Promote a note**, paste a note link, `note1`, `nevent1` or event ID, and
choose a total amount. The editor previews the original note automatically.
**Boost** on a note opens a compact amount picker with its saved split. Choose
**Customize** for appearance, ranking targets and notifications. The main action
stays visible while scrolling on a phone. The original note remains unchanged.

New campaigns default to 80% for visibility and 20% for the original author.
If the author's signed profile confirms no Lightning payment address, a new
campaign defaults to visibility only. Temporary lookup or wallet failures do
not change the chosen split.
Boosts use the campaign's saved allocation. Older campaigns without a saved
split default to 100% visibility. You can change your payment allocation or
enable or disable **Support the author too** through **Adjust** beside the amounts.
A slider shows the author's percentage and both recipient amounts. Turning support
back on restores your selected share. Author sats round down, with at
least 1 sat reserved for visibility. The form shows both amounts before payment.
Author support goes directly to the Lightning address in the author's Nostr
profile. If unavailable or outside that wallet's limits, choose another amount
or explicitly switch to visibility only.

The form shows the recipient amounts and invoice count before confirmation.
**Pay & Boost** or **Pay & Promote** prepares and pays the invoices in sequence
with a connected NWC or WebLN wallet. **Prepare invoices only** keeps manual
payment available. Other wallets can open, copy or scan each invoice. No login
or Nostr signer is needed for ordinary payments. **Wallet** and **Connect Nostr**
are available in the app header and inside the promotion. They connect your NWC
wallet, browser signer extension, or Amber and other remote signers.
An optional signer lets author support use a public zap. That choice ends when
the signer changes or reconnects, the form reopens, or the page refreshes.
Existing invoices remain available; replacing one then uses ordinary author
support. The two payments can succeed independently: the form keeps their separate
statuses and unfinished invoices in the current browser tab after a refresh.
Wallet payment proofs and valid zap receipts confirm author support. Manual
author payments without a proof can only be marked paid by the payer; check your
wallet before retrying. Closing the tab clears this local recovery state.
Wallet connections also stay in the current tab. Connecting never sends a
payment. A lost wallet response leaves the payment uncertain; NWC checks its
status before retrying. You can disconnect at any time and use the invoice links.

From a Nostr client, you can also mention Holoboard with a promotion command
and zap its reply, zap the account with the note reference in the comment, or
DM `PROMOTE <amount> <note>` to receive an invoice. The full command options
are in the [relay README](relay/README.md#promotion-through-nostr).

Appearance, author support, ranking targets and notifications open their own
panels without clearing your choices. Public zap consent is beside author support.
[Help](https://holoboard.space/help) explains ranking and alternative promotion
methods, with the Holoboard pubkey and relay URL available to copy. Contextual
help returns to the editor without discarding its choices. The payment result
confirms the visibility added by your specific invoice, rather than the note's
total. Author support and appearance fees add no ranking or Hot weight.

When a note is promoted for the first time, the Holoboard Nostr account
publishes one quote labelled as a paid promotion. Boosts and later returns to
the board do not create more quotes. New quotes include
[NIP-57 zap split tags](https://github.com/nostr-protocol/nips/blob/master/57.md#appendix-g-zap-tag-on-other-events)
for Holoboard and the author. The first successful promotion fixes this public
split for the campaign. A later payer can change their own allocation without
changing the campaign's split. Zapping the Holoboard share on this quote boosts
the original note; the author share supports its author directly. External
clients decide whether they support splits. These payments are separate and
Holoboard does not forward author funds.

Removing the note from Holoboard publishes
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
below it. **Original** reveals the full text and any remaining attachments.
**Open** opens a note in a Nostr viewer.

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
cannot be paid; the frontend reports test mode instead of offering them to a
wallet. Keep `.env` private and reuse the keys after updates.

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
