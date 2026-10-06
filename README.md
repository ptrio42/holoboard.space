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

Waiting room shows a badge and marks notes first promoted since your previous
visit. Boosts and older notes falling out of TOP 21 do not count as new. Visit
history stays in this browser and is separate for each backend.

Notes show a compact preview for the first ordinary page link, with its title,
domain and available description or thumbnail. Other links remain clickable.
Failed previews leave the original link available.

## Promote a note

Open **Promote a note**, paste a note link, `note1`, `nevent1` or event ID, and
choose a total amount. The editor previews the original note automatically.
**Boost** on a note opens a compact two-line note preview and amount picker
with its saved split. Custom stays in the fifth preset slot in both modes. Switch
between **Amount** and **Position** to choose sat presets or estimated ranking
targets with matching presets in the same picker. **Payment options** includes
wallet connection and confirmation DMs. The full editor uses Promotion, Billboard
and Payment options tabs. Appearance is available in Billboard when starting a
promotion period, including after expiry. Note images have bounded thumbnails,
and Nostr references remain clickable. Expand the note to read its full content.
The main action stays visible while scrolling on a phone. The original note
remains unchanged.

New campaigns default to 80% for visibility and 20% for the original author.
If the author's signed profile confirms no Lightning payment address, a new
campaign defaults to visibility only. Temporary lookup or wallet failures do
not change the chosen split.
Boosts use the campaign's saved allocation. Older campaigns without a saved
split default to 100% visibility. A two-color slider joins the recipient amounts
and percentages into one control. Move its boundary fully toward the author
side for 100% Holoboard visibility and 0% author support, or choose
**Use campaign split** to restore the campaign's allocation. Changes apply to
your payment; the campaign's public split stays fixed. Author sats round down,
with at least 1 sat reserved for visibility. The form shows both amounts before payment.
Author support goes directly to the Lightning address in the author's Nostr
profile. If unavailable or outside that wallet's limits, choose another amount
or explicitly switch to visibility only.

The form shows each recipient amount and the complete total before confirmation.
**Boost** or **Promote** prepares invoices and opens **Promotion payment**.
Choose between equally available **Wallet** and **Invoice / QR** tabs. NWC is
selected first when a connection exists; otherwise invoices come first.
Wallet payment requires a separate explicit action. Invoice payments show one
recipient's QR at a time, with Open in wallet and Copy invoice always available
for that invoice. Select Holoboard or Author to change the displayed invoice.
No login or Nostr signer is needed for payments. **Wallet** connects an optional
NWC wallet; **Payment options** also offers that connection. Nostr connection
is reserved for a later website release. Confirmation DMs still accept a manually
entered npub.

**Restart payment** returns an unpaid session to the same promotion choices
without creating new invoices. Check your wallet before confirming: issued
invoices are not cancelled. A paid, reported, sent or uncertain part blocks a
full restart; finish or reconcile that session instead. An expired unpaid
recipient invoice can be replaced while keeping the other part. Connections
and shared wallet attempt protection are retained.

The NWC wallet panel shows balance, Send, Receive and payment history when the
connection grants access. Send accepts a Lightning invoice, a QR code or a
Lightning Address and asks for confirmation after review. Receive creates an
invoice to copy, share or scan. Read-only and receiving-only connections work;
unavailable permissions are explained in the panel.
Author support uses ordinary invoices in the current website release. Existing
public zap invoices remain usable; replacements use ordinary author support.
The two payments can succeed independently: the form keeps their separate
statuses and unfinished invoices in the current browser tab after a refresh.
Wallet payment proofs and valid zap receipts confirm author support. Manual
author payments without a proof can only be marked paid by the payer; check your
wallet before retrying. Closing the tab clears this local recovery state.
Wallet connections also stay in the current tab. Connecting never sends a
payment. A lost wallet response leaves the invoice protected across connections
and between promotion and the wallet panel. Reconnect the original NWC connection
to check its status; lookup permission is sufficient. You can prepare a different
invoice while that payment remains unresolved. Disconnect at any time and use
the invoice links.

From a Nostr client, you can also mention Holoboard with a promotion command
and zap its reply, zap the account with the note reference in the comment, or
DM `PROMOTE <amount> <note>` to receive an invoice. The full command options
are in the [relay README](relay/README.md#promotion-through-nostr).

Amount, position and allocation controls share one form. Appearance, payment
options and connection panels preserve the draft. Switching Amount and Position
also preserves the amount, allocation and open Custom field.
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
