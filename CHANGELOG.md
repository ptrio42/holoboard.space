# Changelog

User-facing changes, kept as source material for announcements on Holoboard's
Nostr account. Unreleased entries have not yet been deployed. Release dates
record deployment, not announcement publication.

## Unreleased

### Fixed

- Close wallet and profile relay connections safely, preventing a shutdown
  race that could stop the backend.
- Preserve original-note relay hints when settling promotion zaps, including
  after a restart or reconstruction from a signed Holoboard reply.
- Keep public zap consent bound to the selected signer connection, including
  invoice replacement. Changing or reconnecting a signer or refreshing permits
  ordinary author support without carrying consent to another session.
- Handle invoice expiry and wallet confirmation separately for visibility and
  support. A failed author payment confirmed by its original NWC wallet permits
  invoice replacement after expiry without another charge.
- Stop receipt watchers safely after fast wallet payment confirmation.
- Use verified recipient profile sources in new promotion zap splits, while
  retaining existing public quotes and campaign allocations.
- Find author payment profiles through note hints and the author's relays.
  Compare current profiles before creating splits, so a stale address-free
  profile does not remove author support.
  Confirm previously issued author invoices after provider changes or restarts.
- Keep prepared invoices and wallet attempt protection when reopening the form
  with browser storage blocked; explain the refresh limitation.

### Added

- A top 21 main board and a paid waiting room with Top, New and Hot views.
- Direct author support alongside paid visibility, with adjustable allocations,
  browser-wallet payments and separate recipient invoices and payment statuses.
  If author support is unavailable, payers can review and choose visibility only.
- Zap splits on new paid-promotion quotes. Zapping their Holoboard share boosts
  the original note, while the author's share supports the author directly.
- Optional NWC wallet connections and Nostr signers, including browser
  extensions and Amber through a remote signer connection. Invoice links,
  copying and QR payments remain available without an account.

### Changed

- Compact the board header with shorter descriptions and tighter spacing,
  bringing paid notes higher on the page on desktop and mobile.
- New campaigns default to visibility only when the author's signed profile
  has no Lightning payment address. Temporary outages preserve the chosen split.
- Campaigns created before zap splits default to visibility-only boosts.
  Author support remains optional; saved splits and prepared invoices keep
  their allocations.
- Boost opens a compact note and amount picker with its saved allocation.
  Promotion tools and contextual help open separate panels without clearing
  choices; the action stays visible on phones. Author shares use a slider.
- Wallet and Nostr connections are available throughout the app. A connected
  wallet can prepare and pay recipient invoices after one explicit confirmation,
  while invoice links, copying and QR remain available without a connection.
- A dedicated help page explains ranking, payments and promotion from Nostr,
  with account and relay details available to copy.
- Unfinished payments resume after a refresh in the same browser tab. Ranking
  estimates account for the selected author share and include entry into the top 21.
- Author support has a visible on/off switch that restores the selected share.
  Uncertain wallet payments require a status check before another attempt.

## 2026-09-29

### Fixed

- Public promotion requests recover after a relay refuses or drops a mention
  subscription, including requests sent during a brief disconnect. Replies
  retry delivery to relays that were temporarily unavailable.

## 2026-09-24

### Added

- An Android app that opens Holoboard through the verified website.

### Changed

- The promotion dialog now has one invoice flow. Public promotion commands
  and zaps remain available from Nostr clients.

## 2026-09-23

### Added

- Holoboard accepts NIP-17 and legacy NIP-04 `PROMOTE` commands and replies
  with a Lightning invoice in the same conversation.
- Promoters can opt into one DM when the current promotion moves to Expired.
  A signed `YES` confirmation is required, and a revived promotion asks again.
- Holoboard publishes one clearly labelled paid-promotion quote when a new note
  first reaches the board, with durable retry across relay outages and restarts.
- Holoboard can be installed as a PWA and reopens its cached interface when
  the network is unavailable.
- Promotion amounts can target the board's current top three positions, with
  estimates adjusted for weight the note already has.
- The board footer links to the ranking explanation and the project's source.

### Changed

- Promotion forms and DM replies now describe the confirmation message and
  explain how to request a later expiry notification.
- Removed the separate DM tab from the promotion dialog. DM promotions remain
  available directly from Nostr clients.
- NIP-17 messages use durable per-relay delivery, sender history copies and a
  kind 10050 inbox list limited to three working relays.
- Board rows show the sats currently setting their rank, with historical paid
  totals available from the same figure.
- Public promotion replies show the promoted note as a native quote, making the
  zap target clearer while keeping the original note easy to open.

### Fixed

- The footer's ranking link scrolls the promotion dialog to the start of the
  ranking explanation.

## 2026-09-21

### Fixed

- Ordinary replies that mention Holoboard no longer trigger promotion errors
  when an image URL happens to contain a 64-character hash.
- Nostr references remain interactive in billboard text and quoted-note
  previews instead of appearing as raw identifiers or placeholders. Quoted
  notes show a bounded strip of image thumbnails.

### Changed

- Billboard styles inherit the note background, and slides rotate without
  visible counters or navigation controls.

## 2026-09-18

### Added

- Optional billboard appearances: LED, neon, image + LED, terminal, split-flap,
  glitch, poster and slides. Choose a look and preview it before paying.
- Billboard text is selected from the original Nostr note; images also come
  from that note. The original signed event stays unchanged, with links,
  quoted-note previews and the full note available alongside the billboard.
- An introductory appearance fee of 100 sats, deliberately low and subject to
  increase. Appearance lasts for the active promotion period and does not add
  ranking weight. Boosts remain open to everyone and preserve the existing look.
- Up to three slides, with a combined 160-character limit, changing every
  three seconds. Animations pause on hover or tap and respect reduced motion.
- An expired-promotions archive with actions to promote notes again, plus
  a Boost action on active notes.
- A Docker Compose setup and self-hosting guide for running your own board.

### Changed

- Boost and Promote again are compact text actions alongside Open note,
  reducing card height on mobile while keeping comfortable touch targets.

### Fixed

- Delayed invoice payments remain recoverable after expiry. Duplicate payment
  notifications and zap receipts do not add ranking credit twice.
- Relay information is returned when clients send a combined Accept header,
  including the relay description.
