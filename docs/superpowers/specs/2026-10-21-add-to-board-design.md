# Add to board: guided contribution flow

Status: accepted interaction design. The full editor moves to Post, Budget and
Payment stages; compact Boost keeps its short form. This records the intended
behavior, not an implemented or deployed change. Production creation activation
remains a separate release decision. See the
[implementation plan](../plans/2026-10-21-add-to-board-guided-flow.md).

## Goal and scope

Make it straightforward to give a post paid visibility, including for someone
who has no Nostr account. The planned audience has access to a Lightning wallet.
Wallet onboarding, card payments and email/password accounts are separate work.

Support writing text, sharing an ordinary link, promoting an existing signed
post and adding a comment to an existing post. Keep promoting someone else's
post a first-class path. Preserve the compact Boost flow.

The primary usability goal is understanding the next action and what payment
does. A smaller number of clicks alone is not a success criterion.

The accepted recovery scope includes closing the tab and later resuming an
unfinished payment in the same browser profile and application origin on that
device. It does not include cross-device synchronization or restoring guest
author keys. Unsigned draft autosave remains a separate proposed enhancement.

## Current implementation audit

The audit covers the current editor and its opt-in creation mode at source
revision `f7d90b4`, together with the working product documentation. Creation
remains disabled in the Pages production build, independently of its label.
See the [editor guide](../../../web/README.md#add-to-board) and
[product context](../../product.md).

| Current element | Assessment | Proposed treatment |
| --- | --- | --- |
| One field for text, ordinary links and supported Nostr references | A useful entry point without an initial content-type questionnaire | Keep it; show the detected interpretation and allow an explicit change |
| Promotion, Billboard and Payment options tabs | Group controls, but do not explain the task sequence; advanced features occupy navigation space before content is ready | Replace top-level tabs with task progress in the full editor |
| Content, author controls, Review post, amount picker and split in one compose panel | Several independent decisions compete; the main submission action can appear before the post is ready | Separate content from budget and give each stage one primary action |
| Review post signs privately before invoicing | Protects exact content and delays publication until settlement | Keep the contract; integrate review into the transition from content to budget |
| Guest author explanation and optional key export | The export is valuable, but key terminology adds a technical decision to writing | Keep optional export accessible after signing; explain it in a contextual disclosure |
| Amount presets, Custom and estimated target positions | Provide fast choices and a path for experienced promoters | Keep Amount as the default; retain Position as an inline alternative and Custom in the fifth slot |
| Recipient amounts, percentages and allocation slider | Make the use of funds visible before payment | Keep together for eligible posts; show a simple visibility-only summary for guest posts |
| Campaign split defaults and restoration | Preserve expectations when promoting another person's post | Keep; never silently replace a selected split after a temporary wallet failure |
| Billboard preview and optional appearance fee | A useful optional upgrade, unrelated to the basic contribution decision | Open from the budget stage with its fee visible; preserve original signed content |
| Wallet setup and notifications under Payment options | Useful capabilities, but wallet setup precedes and duplicates decisions on the payment screen | Put optional connection next to the payment method; keep Notifications explicitly optional |
| Fixed footer with the complete total | Keeps the next action available on phones | Keep the shared Modal shell and fixed action footer |
| Invoice / QR and Wallet methods | Permit account-free payment and optional convenience | Keep equally available; select invoices first without a saved wallet connection |
| Unfinished sessions, per-recipient status and explicit recovery | Necessary for avoiding duplicate payments | Preserve in the new navigation; recovery must stay visible when needed |
| Compact Boost | Already skips choosing content and avoids the full editor tabs | Keep compact; do not require the full wizard |

The visual evidence includes the guest editor at 320, 390 and 1280 CSS pixels.
Those captured states include expanded optional author-key help; they are not
evidence that this help is expanded by default. Source inspection establishes
the other audit findings. No comparative usability study has been conducted.

## Alternatives

| Approach | Benefit | Cost | Assessment |
| --- | --- | --- | --- |
| Three stages: Post, Budget, Payment; optional panels within their stage | Clear next action and short default path | More navigation than a single form; requires careful state preservation | Recommended for the full editor |
| Four stages: Post, Budget, Extras, Payment | Optional features get a dedicated explanation | Everyone must encounter an extra decision or skip action | Use only if research shows extras need their own stage |
| One page with progressive sections | Fast to scan and revise on a wide screen | A phone can still accumulate a tall form and competing controls | A viable alternative if the guided flow feels slow in testing |

W3C's [multi-page forms guidance](https://www.w3.org/WAI/tutorials/forms/multi-page/)
supports logical groups, visible progress and easily skipped optional stages.
GOV.UK's [form structure guidance](https://www.gov.uk/service-manual/design/form-structure)
starts with one task per page and uses research to decide when to combine them.
These are design references, not proof that this proposal improves completion.

## Recommended interaction

Use the same sequence on phone and desktop, with the existing pixel typography,
notched controls and neon palette. Keep `Add to board` as the title and show
`Post / Budget / Payment` as progress, with the current stage announced. Previous
completed stages are reachable; future stages explain their prerequisites.

The steps replace category tabs. A desktop summary may use the spare width, but
must not introduce a different decision order. On phones, keep one column and
the current action above the safe-area inset. Opening help or an optional panel
preserves the stage and restores focus to its trigger.

### 1. Post

Lead with `What would you like to share?` and one text field:
`Write something, share a link, or paste a post`.

- Text or an ordinary link creates a new post. An ordinary URL is linked,
  not imported as if the contributor authored the destination's content.
- A supported standalone Nostr reference selects the original post. Show its
  author and preview, with `Add a comment` as an optional action.
- Adding a comment creates a separate post quoting the source. Removing the
  comment does not silently revert to promoting the original; keep `Use original`.
- Load the first ordinary link preview and first quote using the existing
  renderer. A failed web preview does not prevent continuing; unverifiable
  quoted sources do.

For a signed-out contributor show `Posting as a guest. No account required.`
Keep `Use a Nostr account` secondary and available only when enabled. A connected
contributor sees their identity and retains the option to post as a guest.
Do not ask people to select guest versus account before they can write.

Make paid visibility and public publication clear at this stage:
`Pay with Lightning to add this post. New posts become public after payment.`
Explain in contextual help that public posts can be delivered to other Nostr
apps and removal cannot guarantee deletion of external copies. Do not promise
payment privacy or recoverable guest identity.

The primary action is `Review & continue`. For new content it verifies
references and signs the exact post privately, using the existing Review post
contract. For an existing post it validates and loads the original without
signing or modifying it. A connected author sees an adjacent explanation that
their signer will request approval. Nothing is invoiced, paid or published here.
Returning through Post without changing content, interpretation or authorship
reuses the private signed event instead of requesting another signature or
creating a new guest identity.

The next stage presents that exact content for review before invoice creation.
`Save author key` remains available for a signed guest post in author details
before invoice creation and while its in-memory key exists. Its warning explains
identity control and loss after editor closure, refresh or reviewing an edited
post that replaces that guest key. Export is optional; it must not claim to
provide recovery of the payment or deletion everywhere.

When creation is disabled, keep the `Add to board` title but make Post an
existing-post selector. Label the field `Post link`, put supported Nostr reference
formats in help, and explain `Choose an existing Nostr post. Writing new posts is
not available in this build.` Do not display the generic writing placeholder,
guest-author creation controls or Add a comment. The remaining stages retain
promotion, anonymous payment and recovery for existing posts. Previously issued
creation invoices remain recoverable even when new creation is disabled.

### 2. Budget

Show a compact, expandable preview with `Edit post`, followed by
`How much would you like to spend?`.

- Start with the existing Amount presets and current default. Keep the inline
  Position mode, matching ascending-cost choices and fifth-slot Custom control.
  Mark positions as estimates. Explain sats as small bitcoin units in brief help.
- Show the Holoboard visibility amount, original-author amount, percentages and
  two-color slider together when author support is available. Preserve campaign
  defaults and a reset action. Only visibility contributes to ranking.
- For guest-authored posts, replace the disabled allocation control with
  `All of this amount goes to visibility.` Do not present a changeable split
  when the current guest policy fixes it at 100% visibility.
- Distinguish confirmed missing author payment details from temporary lookup
  failure. Keep retries and explicit visibility-only recovery beside the action.
  Do not reduce author support automatically to make the form submit.
- Expose an optional `Billboard appearance · +{fee} sats` entry. It opens the
  existing appearance controls and actual preview, then returns to Budget.
  Show a changed appearance choice and its fee in the budget summary.

Keep eligible appearance upgrades available only at the beginning of a promotion
period, including revival after expiry. The active campaign keeps its appearance.
The entry can still explain availability before content is ready, without
presenting a top-level category tab or editable unsupported state.

The fixed footer shows the complete total including appearance. The primary
action is `Continue to payment · {total} sats`, with brief adjacent text:
`Creates invoices. No payment is sent yet.` The final content, recipients and fee
are visible before this action, following the intent of
[checking answers](https://design-system.service.gov.uk/patterns/check-answers/).

When enabled and relevant, optional public-author support remains beside the
split. Notification choices can be opened from a quiet `Payment options` entry
at this stage, because they must be set before invoices are created. Keep an
explicit Notifications heading and confirmation-DM controls. Guests do not see
inapplicable account-bound notification or public-zap controls.

### 3. Payment

Show the frozen post summary, complete total and actual recipient amounts.
Keep Invoice / QR and Wallet as payment methods, rather than editor categories.
Invoices come first for someone without a saved connection; Wallet comes first
when connected or restoring a connection. Preserve the chosen method and
recipient through help, connection settings and navigation.

The invoice method makes `Open in wallet`, `Copy invoice` and its QR immediately
available without sign-in, signer access or wallet connection. A single-recipient
payment needs no recipient-selection control. With author support, explain
`Two payments: visibility and author support` and show each amount and status.
Do not imply that one QR pays both recipients.

Wallet connection is optional and lives beside the Wallet method. Sending always
requires a separate `Pay {remaining} sats` action. Show progress inside the action,
then place unresolved warnings beside recovery controls. Account connections
must never stand in for payment-wallet connections.

The existing invoice engine remains responsible for settlement, wallet attempts,
replacement and per-recipient status. A manually reported author payment remains
unverified. Once visibility is confirmed, do not show a remaining author payment
as if the board placement had failed.

Finish with the existing explicit result summary and `Done`. For new posts,
distinguish confirmed board payment from pending external relay delivery.

### Existing posts, Boost and recovery

- A known inactive post starts at Budget with its content selected and an
  available review action. Explicit Boost on an active post uses the compact
  path. An active original pasted into general Post can still be reviewed or,
  when creation is enabled, used as the source of a new comment.
- Boost retains its two-line preview, inline amount/position controls, split,
  contextual options and fixed total. It does not gain a stepper or category tabs.
- General Add to board opens a blank Post stage. If unfinished payments exist,
  show a compact explicit resume entry instead of restoring an unrelated post.
- Selecting a saved payment opens its Payment state and its own snapshot.
  Expired, unattempted sessions may open in editing while keeping invoices.
- `Back to budget` remains available after an attempted or partial payment.
  It stops remaining wallet sends and preserves issued invoices and attempts.
- After returning from Payment, show the selected unfinished payment and its
  frozen total above the budget form. Resume must be visible before the action
  that prepares a new payment, including when the body needs scrolling.
- Editing a post invalidates its private review and resets post-bound options;
  retain the current new-post budget where existing composition behavior permits.
  Choosing a different existing post resets its draft and account-bound consent.
  Neither operation modifies an older invoice snapshot.
- Never label navigation or clearing a draft as invoice cancellation. Attempted,
  paid, reported and uncertain records retain the existing restart protections.

### Recovery after closing the tab

Current payment sessions and shared wallet attempts use sessionStorage. That
supports refresh within the page session, not a reliable fresh-tab return after
closure. See the [storage lifetime documentation](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage).
The earlier passing fixture covers refresh only; the accepted same-device
recovery requirement needs new implementation and evidence.

Persist issued invoice snapshots, archived invoices, settlement/report status
and shared wallet-attempt records in private browser storage. Keep this data
separate from public note caches and the publication outbox. Recovery records
must retain their backend identity so a preview cannot adopt production invoices.
Do not persist guest private keys, signer secrets or NWC credentials for this
feature. Signing in later does not change an earlier guest post's author.

Returning users select an unfinished payment explicitly. Restoration must not
prepare another invoice, connect a wallet automatically, sign, publish or send.
Check settlement for attempted payments and preserve pending/unknown states
before offering another send. A stored proof must be verified again after load.
Promotion and Wallet Send must share protection for the same invoice hash,
including when opened in different tabs. Save the uncertain attempt durably
before a wallet send can begin.

Use transactional browser storage and established browser coordination APIs;
do not implement an ad hoc lock using read-modify-write localStorage. IndexedDB
and Web Locks are the initial implementation candidates, with their behavior
verified in the supported browser engines:
[IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB),
[Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API).
If durable storage is blocked or full, keep issued invoices available in memory
and make the reduced recovery guarantee visible. Invoice open/copy/QR remains
available; do not initiate a wallet send if its attempt cannot be saved safely.

Do not promise recovery after browser data is cleared, in another browser/profile
or origin, or after the browser discards site storage. Retaining payment data
does not retain an unsaved guest author key. Never silently delete unresolved
records because their invoice expires. Recovery storage and cross-tab state
need a compatible rollback baseline before the editor redesign is released.

### Details to validate in the working prototype

These are proposed refinements, not additional accepted features:

- After returning to Budget, show an existing payment's confirmed amount and
  unresolved parts beside an explicit Resume payment action. Preparing a new
  payment must be visibly separate and show its own complete total. For example,
  a 500-sat invoice with 400 sats of visibility confirmed and 100 sats of author
  support pending must not make another 500-sat payment look like a continuation.
  Uncertain payments need a status check rather than a claim that money is owed.
- Use Edit post for an unissued draft and Change post for an existing signed
  source. Existing original content stays immutable; adding commentary creates
  a separate quoted post. Appearance editing remains separate from either action.
- Clarify the budget wording without changing arithmetic: the selected amount
  is allocated to visibility and author support; Billboard adds a separate fee.
  A 500-sat selection and a 100-sat appearance fee have a 600-sat complete total.
- Add Open post and Copy link to the successful result, with Done retained.
  Resolve the actual permalink behavior with reader flags disabled and external
  publication pending before choosing a destination. A link should not send a
  guest to an unavailable external copy or imply an unimplemented local route.
- Decide a new account-authored post's default split explicitly. The current
  guest policy is visibility-only, while a signed-in author's receiving address
  can produce a second invoice to that same author. Consider visibility-only
  for a newly created own post; keep existing campaigns' saved splits unchanged.
  This would change the new-campaign default and needs a separate decision.

Validate the flow on an actual phone by opening its wallet and returning after
the app was backgrounded. Use local mocks for automated state checks; an actual
funds transfer needs its own explicit authorization. Compare comprehension with
Lightning users unfamiliar with Nostr before adding more entry modes or options.

## Implementation boundaries and sequence

1. Prototype the accepted three-stage interaction and its exceptions with the
   same short post, long post, ordinary link and existing source. Keep current
   behavior documentation distinct from this accepted implementation direction.
2. Establish private same-device recovery and shared cross-tab attempt protection
   as an independently verified foundation, including compatible rollback.
   Then add editor-stage navigation around existing composer, amount picker,
   allocation and optional panels. Keep the composer mounted while navigating so
   live text, guest keys and signing state are preserved. Maintain a separate
   state for editor progress and invoice lifecycle.
3. Move optional controls to their described context. Reuse the existing Modal,
   shared UI, note renderer, BillboardEditor and connection settings. Keep help
   available and preserve its return focus and stage.
4. Connect Budget to the current invoice preparation operation and Payment to
   the current payment engine. Keep payment hashes and frozen snapshots as the
   authority for asynchronous callbacks; navigating stages is not a payment reset.
5. Verify the changed transitions and update the editor guide, relevant local
   instructions and Unreleased changelog only when behavior is implemented.
6. Treat enabling creation on production as a separate reviewed release change,
   including a compatible backend and the outstanding creation/rollback gates.

Do not combine this work with authentication architecture, new payment rails,
publication-engine replacement or unrelated reader changes.

## Evaluation across perspectives

Evaluate the complete Add to board journey from entry to result and later
recovery. Different perspectives are complementary review criteria, not claims
that independent designers or real users have already tested the proposal.
The accepted three-stage interaction remains the direction under review.

| Perspective | Current finding or concern | What the new flow must demonstrate |
| --- | --- | --- |
| First-time contributor without Nostr | Writing competes with identity/key explanations and payment controls; the visible invoice action can be disabled while Review post is below the fold | Start with text or a link, understand the next action and paid public publication, and proceed without an account or wallet connection |
| Returning promoter | Compact Boost and explicit invoice recovery already remove unnecessary setup | Boost stays short; continuing an existing payment remains distinct from preparing a new one |
| Original author and reader | A payer can promote someone else's post; appearance, authorship, support and ranking have separate meanings | Preserve attribution and signed originals, identify who receives money, and keep the underlying post readable |
| Interaction designer | Current category tabs organize controls but do not express task order | One primary action per stage, clear progress, contextual extras, useful validation and predictable Back/Close behavior |
| Spatial and responsive designer | Writing and its duplicate full-height preview consume most of the visible body before budget controls appear | Use the available reading/editing width, avoid duplicate full-height short content, and keep progress, summary and footer from crowding out the active task |
| Visual designer | Existing pixel type, notched controls and neon colors provide a consistent language | Preserve that language with clear action hierarchy, legible labels and totals, consistent grouping and distinct focus, disabled and pending states |
| Content designer | Nostr formats, signer operations, sats and two-recipient payments introduce unfamiliar concepts | Use task language first, contextual explanations and action labels that distinguish review, invoice preparation, sending and completion |
| Accessibility reviewer | Rendered geometry alone does not establish contrast, keyboard, zoom or screen-reader usability | Verify reflow, visible focus, control names, status announcements, sufficient targets and QR access above decorative effects |
| Reliability and product reviewer | Refresh recovery has evidence; cross-session recovery and improved usability do not yet | Demonstrate recovery and no duplicate sends; separately observe whether target users understand the purchase and complete their intended task |

### Spatial audit evidence and limits

A supplementary browser audit of the current creation-enabled editor used a
guest post with the text `A community meetup this Saturday. Details:
https://example.com/story`, its ordinary-link fixture preview, a separate long
text case, and viewport sizes 320x640, 390x844, 768x900 and 1280x900 CSS pixels.
The 768px capture covers the initial state; later editor/payment states were
inspected at selected phone and desktop widths. Measurements were taken after
resize frames settled and rounded to whole CSS pixels. Author-key help stayed
collapsed.

At 390x844 while typing the short linked post, the textarea and rendered preview
each measured 236px high. Together they used 472px of a 597px visible scrolling
body, before accounting for their labels and other controls. The amount picker
started at viewport y=834, below that body's lower edge at y=715. The result is
vertical displacement despite no horizontal page overflow. At 1280x900 the two
blocks each measured 252px, so widening the screen did not remove the duplication.

These are fixture measurements, not traffic data, a conversion result or a
universal claim about every post. The current invoice view kept its QR and
open/copy actions available in the observed normal-phone state. Keep that
strength while reducing redundant single-recipient selection.

The close button's rendered box measured 34x28px and several mode/review controls
were 37px high. Review their effective touch targets against Holoboard's generous
control conventions. Do not label these measurements automatic WCAG failures:
WCAG 2.2 AA's [target minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
is 24x24 CSS pixels with defined exceptions, while 44px is the preferred project
target for primary touch actions. Contrast, screen-reader use and physical
virtual-keyboard behavior were not established by this audit.

### Spatial acceptance for the new flow

- Post prioritizes comfortable writing. Avoid showing two full-height versions
  of short content by default; an expanded preview or the reviewed Budget
  summary can carry the full rendered post. Preserve required link/quote previews.
- Budget prioritizes amount, recipient split where applicable and the complete
  total. Use a compact expandable source summary, without repeating the editor.
- Payment prioritizes recipient/status, usable QR and payment actions. Keep
  editor progress visually subordinate to the active task and payment method.
- On a short phone, measure the combined height of title, progress, method
  selector, warnings and footer. Do not add a full-height navigation row for
  each category or compress labels and hit areas just to fit.
- On desktop, use a bounded readable column. A secondary summary column is
  justified only if it improves the task without competing with the primary
  action or creating a different sequence from mobile.
- Default full-editor content may scroll; no-scroll remains the specific compact
  Boost contract. Large text, expanded media and recovery warnings take priority
  over an arbitrary promise that every full-editor state fits on one screen.
- Compare identical short/long text, source, link and relevant media fixtures
  before and after. Record reading width, usable body height, required scrolling
  and action visibility. Treat keyboard-open and zoom states separately from a
  narrow desktop browser screenshot.

Use [WCAG reflow guidance](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)
and [focus visibility around fixed content](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)
as accessibility references. Shared pixel typography and existing status/modal
components remain the implementation baseline. A generic checklist does not
authorize changing the accepted brand or prove accessibility conformance.

### Evidence status

- Expert review of task order, current source, spatial composition and payment
  contracts: completed for the current implementation and proposed direction.
- Automated visual capture: completed for one local Chromium fixture and the
  stated viewport/state sample, with no external publication or wallet sends.
- Implemented three-stage layout, its complete state matrix and accessibility
  behavior: pending implementation and targeted inspection.
- Agent-led task walkthrough of the working three-stage prototype: the next
  usability evaluation, followed by ptrio42's separate review.
- Physical phone/wallet round trip: pending device evidence. Additional
  participant research can provide further evidence, but recruiting participants
  is not a prerequisite for the agent-led pass or ptrio42's review.

### Visual comparison before implementation

The selected visual direction is **A, Open layout**, following the comparison
of the same guest post, amount and three stages in open and compact compositions.
Preserve A's open column, restrained separators, limited frames and clear task
progress. The compact B composition is not the implementation baseline.

Use the [selected visual reference](assets/add-to-board-open-layout.png) and its
[generation prompt](assets/add-to-board-open-layout-prompt.md). The image sets
composition, not exact typography, control geometry or payment behavior. Its
illustrative labels do not replace the written signing, notification, frozen
invoice or guarded Back contracts. Side-by-side payment buttons remain a
separate suggested refinement, not part of the selection of A.

The clickable HTML/CSS mock is approved by ptrio42 as the visual baseline for
implementation. Preserve its open layout, hierarchy and Post, Budget and Payment
progress. Visual approval does not establish the production payment, recovery,
signing or publication behavior; those still require implementation and checks.

The [clickable Concept A mock](../../../web/prototypes/add-to-board/README.md)
provides Post, Budget and Payment navigation, contextual appearance and payment
options, account-free demo invoices, frozen in-memory invoice snapshots, partial
payment results and a compact Boost example. Serve it through the existing Vite
development server at `/prototypes/add-to-board/`. The outer Example selector
changes the fixture; it is not part of the proposed product interface.

This is an isolated visual checkpoint. It does not modify production components
or feature flags. It has no actual source resolution, signing, wallet calls,
settlement or publication. Reloading clears its demo payment records. Its
in-memory Resume interaction does not establish the accepted durable recovery
or cross-tab guarantees; those still belong to the implementation plan.

### Following pass: working prototype and agent-led task walkthrough

Implement the accepted local flow, then give the reviewing agent concrete goals:
share a new ordinary link as a guest, promote someone else's original, add a
comment explicitly, change budget/appearance and return, and resume an unfinished
payment after closing its tab. Include compact Boost and a failed or uncertain
payment. Use mock payments and preserve the accepted recovery requirements.

The agent's first attempt uses the visible interface, its labels and available
help to decide what to do. Do not provide a selector-by-selector route or use
source code as the interface's instructions. After identifying a problem,
implementation inspection is appropriate for diagnosis and fixes.

Record the goal, attempted route, outcome, confusing label or hidden control,
severity and supporting screenshot or state. Distinguish task blockers, misleading
payment/identity expectations and minor visual polish. Fix demonstrated defects
and recheck affected tasks. Report missing functionality as unfinished work,
not a passed scenario. ptrio42 assesses the resulting prototype separately.

## Acceptance and evaluation

Check the affected flow at 320, 390 and 1280 CSS pixels, including a short phone
with the keyboard open. Preserve readable text, accessible focus order, Escape,
focus return, progress announcements and a visible primary action. Optional
panels and validation errors return to the correct stage without losing choices.

Cover guest text and links, existing originals, explicit quotes, connected
authors, self-authored versus other-authored posts, unavailable author support,
Billboard eligibility, empty custom amounts and both creation-flag states.
Do not advertise direct creation in a build where it is disabled.

Payment regressions must cover account-free QR/open/copy, one and two recipients,
optional NWC, failed and uncertain sends, partial settlement, back-navigation,
refresh recovery, fresh-tab recovery after closure, expired replacement and a
late callback from an older invoice. Include competing tabs and shared Wallet
Send attempts, disabled storage and backend isolation. Cross-session recovery
tests must not transplant sessionStorage into the new tab to make them pass.
Creation release acceptance also requires guest-only and Nostr-account composer
coverage and PWA update/rollback preservation. One passing local fixture does not
close those outstanding release gates.

Before implementation, the existing guest creation browser case was run in one
Chromium project with mocked endpoints. It passed, including its 320/390/1280
layout assertions, refresh recovery and confirmed-payment result. This supports
preserving the current behavior, not the usability of the proposed design.

The required user-perspective pass is the agent-led walkthrough described above,
with ptrio42's own assessment separate. Evaluate whether the interface explains
who receives the money, distinguishes invoice preparation from sending, exposes
optional appearance and allows resuming without paying visibility twice.
Additional research with Lightning users unfamiliar with Nostr is optional
follow-up evidence. Agent task results support concrete usability findings;
they do not establish measured human conversion or completion rates.
