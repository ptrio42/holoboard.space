# Changelog

User-facing changes, kept as source material for announcements on Holoboard's
Nostr account. Unreleased entries have not yet been deployed. Release dates
record deployment, not announcement publication.

## Unreleased

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
