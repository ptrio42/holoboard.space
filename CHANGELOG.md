# Changelog

User-facing changes, kept as source material for announcements on Holoboard's
Nostr account. Unreleased entries have not yet been deployed. Release dates
record deployment, not announcement publication.

## Unreleased

### Changed

- Removed the separate DM tab from the promotion dialog. DM promotions remain
  available directly from Nostr clients.

## 2026-09-23

### Added

- Promote via DM is a first-class option in the promotion dialog. Holoboard
  accepts NIP-17 and legacy NIP-04 `PROMOTE` commands and replies with a
  Lightning invoice in the same conversation.
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
