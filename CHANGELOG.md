# Changelog

User-facing changes, kept as source material for announcements on Holoboard's
Nostr account. Unreleased entries have not yet been deployed. Release dates
record deployment, not announcement publication.

## Unreleased

### Added

- Holoboard publishes one clearly labelled paid-promotion quote when a new note
  first reaches the board, with durable retry across relay outages and restarts.
- Holoboard can be installed as a PWA and reopens its cached interface when
  the network is unavailable.
- Promotion amounts can target the board's current top three positions, with
  estimates adjusted for weight the note already has.
- The board footer links to the ranking explanation and the project's source.

### Changed

- Board rows show the sats currently setting their rank, with historical paid
  totals available from the same figure.
- Public promotion replies show the promoted note as a native quote, making the
  zap target clearer while keeping the original note easy to open.

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
