# Changelog

User-facing changes, kept as source material for announcements on Holoboard's
Nostr account. Unreleased entries have not yet been deployed. Release dates
record deployment, not announcement publication.

## Unreleased

### Changed

- Compact the mobile header into a linked H, Promote action and pixel wallet
  icon above section navigation. Move Help to a single footer link and keep
  new-note counts compact on phones.

## 2026-10-07

### Fixed

- Update the link-preview HTML parser and build dependencies to include security
  fixes, and build the relay with a supported Go toolchain.

- Keep quoted-note lookups stable across board refreshes and reuse cached notes.
  Continue waiting for slow relays and offer an explicit retry after a timeout.

- Initialize the relay URL safely when multiple clients connect at startup.
- Keep the Amount and Position picker steady in Promote and Boost, with Custom
  available in both modes and consistent pixel typography in the page footer.

- Find notes through author outboxes while querying reference hints and board
  relays. Preserve hints in pasted links and include metadata discovery relays
  when looking up the author's Lightning payment profile.
- Verify payment proofs before confirming wallet payments, including promotion
  payments and restored attempts. Keep unverified reports protected from resending.
- Keep uncertain and confirmed invoice payments protected across NWC connections
  and between promotion and the wallet panel. Allow status recovery with lookup
  permission alone and new invoices while unresolved payments remain protected.
- Detect mock invoices before offering payment or contacting a wallet, and
  ignore saved visibility-only test invoices when reopening the form.
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

- Preview the first ordinary page link in notes, quotes and expanded promotion
  previews, with page metadata fetched by Holoboard and a usable link on failure.
- Show new waiting-room promotions since the previous visit with a navigation
  badge and New marks, counting all pages without treating boosts as new notes.

- An NWC wallet panel with balance, reviewed invoice and Lightning Address
  payments, camera and image QR scanning, receiving invoices and filtered
  payment history. Show connection permissions and available spending budgets,
  accept read-only connections, and preserve uncertain sends across refreshes.
- A top 21 main board and a paid waiting room with Top, New and Hot views.
- Direct author support alongside paid visibility, with adjustable allocations,
  browser-wallet payments and separate recipient invoices and payment statuses.
  If author support is unavailable, payers can review and choose visibility only.
- Zap splits on new paid-promotion quotes. Zapping their Holoboard share boosts
  the original note, while the author's share supports the author directly.
- Optional NWC wallet connections. Invoice links, copying and QR payments remain
  available without an account. Nostr signer support is held for a later release.

### Changed

- Improve small-label readability and unselected controls, keep forms clear of
  scanlines and their action footer at the bottom, and use shared pixel loading
  and empty states across the board, note previews and wallet history.
- Label the main board TOP 21 and hold Nostr signer connections for a later
  website release. Wallets, anonymous invoices and manual notification npubs
  remain available.

- Make the wallet balance prominent with Holoboard's pixel display, distinct
  Send and Receive actions, and clearer incoming and outgoing payment history.
- Use the same board heading, section navigation, connections and footer for
  expired notes. Shorten the waiting-room link and use the shared pixel button.
- Group note controls in a compact footer, with pixel styling, notched Boost
  buttons and short Open links for notes and quotes. Move reply context beside
  the author and expand quoted previews without cutting through their controls.
- Group wallet and help controls with the board heading in a consistent
  pixel style. Give section navigation and Rank, New and Hot sorting more space,
  with explanations available through contextual help. Gold marks the selected
  section and sort; selecting the current sort keeps the visible notes in place.
- New campaigns default to visibility only when the author's signed profile
  has no Lightning payment address. Temporary outages preserve the chosen split.
- Campaigns created before zap splits default to visibility-only boosts.
  Author support remains optional; saved splits and prepared invoices keep
  their allocations.
- Boost opens a compact two-line note preview and amount picker with its saved
  allocation. Custom stays in the fifth preset slot for both amount and position
  presets. Ranking explanations remain in Help. Note previews keep images as
  bounded thumbnails and Nostr references as links, with reading actions beside
  the author in boosts.
  Switch between sat presets and ranking targets in the same picker, and adjust
  the split with one two-color control joining recipient amounts and percentages.
  Restore the campaign allocation at any time. The full editor has Promotion,
  Billboard and Payment options tabs, with the total and payment action available
  across all three. Wallet connection and optional notifications share payment
  options; public zaps stay beside the split. Boosts keep the compact form.
  A shorter footer keeps the complete total on the action and moves ranking rules
  into help.
  Contextual panels preserve choices, and the action stays visible on phones.
  Controls and short labels use consistent pixel typography, with readable
  monospace content, payment amounts and input values.
- Wallet connections are available throughout the app; Nostr signer UI is held
  for a later release. A connected wallet pays after reviewing prepared invoices
  in Promotion payment. Equal
  Wallet and Invoice / QR tabs keep both methods accessible, with recipient
  amounts, payment states and an immediately visible QR. Unpaid sessions can
  restart with their promotion choices preserved; unresolved wallet attempts
  and paid parts stay protected. Expired recipient invoices can be replaced
  individually to finish a partially paid promotion. Completed payments end
  with a clear summary and Done action. Wallet progress uses calmer status
  panels, reserving warning accents for unresolved outcomes. Returning to the
  editor keeps partial and uncertain payments available to resume, with separate
  records for each note and earlier invoices. New promotions open a blank editor;
  changing notes clears the previous draft. Billboard explains note loading before
  its options appear. Missing author-payment confirmations explain the amount
  and the wallet-history check.
- A dedicated help page explains ranking, payments and promotion from Nostr,
  with account and relay details available to copy.
- Unfinished payments resume after a refresh in the same browser tab. Ranking
  estimates account for the selected author share and include entry into the top 21.
- Uncertain wallet payments require a status check before another attempt.

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
