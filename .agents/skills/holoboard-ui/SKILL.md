---
name: holoboard-ui
description: "Review, prototype and implement visual changes across Holoboard screens using its existing visual language and real content. Use for layout, typography, media presentation and interaction feedback on the board, discussions, profiles, wallet, promotion editor and navigation."
---

# Holoboard UI

Improve the requested surface while preserving its functional contracts and
accepted design decisions. Match the requested stage: assessment, alternatives,
mockups or implementation. Approval of a visual direction applies to that scope.

## Establish the current context

Resolve repository paths from the checkout containing this skill. Read its
[AGENTS.md](../../../AGENTS.md) when available, including linked instructions,
and the [visual conventions](../../../web/README.md#visual-conventions).
AGENTS.md is local and may be absent in a new checkout; report that and use the
available repository documentation and session decisions. These sources own
product rules, typography, colors, control conventions and feature availability.
Keep this skill focused on the workflow rather than copying those rules here.

Inspect the current implementation and Git status before proposing changes.
When another checkout owns ongoing feature work, base visual work on a committed
feature checkpoint in an isolated checkout and record that base for integration.
Avoid modifying the other checkout. Read the relevant contracts in
[docs/nostr.md](../../../docs/nostr.md) when touching reading, account, navigation
or payment surfaces. Preserve their state and feature gates during visual work.

## Decide what deserves space

Identify the primary content and action for this surface. Explain which elements
currently compete with them and how a proposed change improves that hierarchy.
Choose author prominence, content density and action emphasis for the screen's
purpose; the compact identity on a board card does not define a profile header.

Treat useful visible content, media legibility, action discoverability and whole
screen density as joint criteria. Inspect grouping and contrast when statistics
look clickable or every element demands attention. Keep progress indicators
distinguishable from actions. Place pending status, errors and recovery where
the user performs the affected action, including when the surrounding panel
scrolls. Preserve the meaning of partial, unavailable and unverified data.

## Compare using representative content

Use the same frozen public content and viewport sizes across alternatives.
Record public event IDs and enough fixture data to reproduce each case. Include
the relevant combinations of short and long text, screenshots, portrait and
landscape photos, galleries, links, video and quoted context. Preserve original
signed content. Include separate short and long text-only cases. Measure usable
reading width, including reserved padding, as well as outer bounds. Avoid
invented headings or rewrites that make a layout look better.
Include active billboard appearances with their underlying attachments when
reviewing board content; ordinary-note comparisons do not exercise that path.

Include a narrow phone, a normal phone and desktop. Exercise long identifiers,
missing media, empty results, loading and partial data where they affect the
surface. Inspect both individual items and a whole list for accumulated height.

When a decision is open, compare a few materially different compositions while
holding unrelated typography and controls steady. Explain the tradeoff in
visible content and interaction cost. Once the user chooses, retain that choice
unless new evidence exposes a concrete problem. Repeat the comparison with
implemented components after mockups establish a direction. Visual checks can
support readability and usability judgments; campaign effectiveness needs
separate outcome measurements. Extra expansion clicks alone are inconclusive.

## Reuse components and preserve interactions

Inspect shared components before adding another rendering path:

- [NoteContent](../../../web/src/components/TextRenderer/NoteContent.tsx),
  [InlineNoteText](../../../web/src/components/TextRenderer/InlineNoteText.tsx)
  and [NoteMediaGallery](../../../web/src/components/TextRenderer/NoteMediaGallery.tsx)
  provide content composition, local expansion and full-image viewing. Choose
  media and embed behavior appropriate to the surface.
- [UI components](../../../web/src/components/ui) provide Avatar, PixelButton,
  PixelPanel, NoteControls, StatusMessage and Modal. Inspect their current APIs
  and styles before introducing equivalents.

Keep text expansion local to its text block, media instances stable during
expansion and independent quoted content independent. Preserve expanded state,
focus and source-card alignment across navigation where those contracts exist.
Inspect the first visible frame as well as the settled view; delayed realignment
can hide a visible jump. For content-dependent placement, check loading, loaded
and unavailable states, width changes and local expansion. Check that fallback
layouts reclaim unused space while preserving a single live preview and media
playback. Use inert measurements without media sources so measurement does not
start reads or image/video requests.

Use the shared modal and popover behavior. Verify keyboard ownership, Escape
and focus return when a viewer or contextual panel opens above another dialog.
Visual changes must preserve anonymous invoice access, payment drafts and
explicit wallet-send actions. Keep Nostr reads, identity storage and payment
state within their existing owners. Expand functional scope only when the user
requests it or a concrete defect requires an explained fix.

## Verify and hand off

Use the [frontend development and test instructions](../../../web/README.md)
for the affected surface. Select existing browser coverage under
[web/tests](../../../web/tests), such as notes, discussions, profiles, header,
wallet or payments. Add regression coverage for fragile behavior introduced by
the change. Documentation-only work needs document and reference validation.

For code changes, run applicable lint, builds and tests, then inspect actual
components at the selected widths and relevant states. Test shared controls in
their other affected callers. Run crypto-heavy unit fixtures separately from
multi-browser workloads; investigate local contention before extending timeouts.
Follow documented port and output-directory isolation for concurrent previews.

Return reviewable local changes with their feature base, verification and any
material limits. For integration handoffs, identify the revision where checks
ran and distinguish visual branch evidence from verification of the integrated
result. Link the maintained visual conventions and relevant browser cases for
the receiving branch.
Update existing documentation when a durable rule changes and record user-facing
behavior under CHANGELOG.md Unreleased. Keep release and external-action
authorization separate from local implementation. Carry the accepted decisions
into the next iteration without creating a session chronicle.
