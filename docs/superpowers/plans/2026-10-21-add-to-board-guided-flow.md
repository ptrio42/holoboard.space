# Add to Board Guided Flow Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the full editor's category tabs with Post, Budget and Payment stages while preserving compact Boost, account-free invoices and recoverable payments.

**Architecture:** First extend the existing payment-session and shared-attempt owners with private browser persistence and cross-tab coordination. Keep BoardComposer mounted as the owner of live text, interpretation, private signing and the in-memory guest key; DirectPromote owns budget and invoice lifecycle, with editor progress separate from payments and contextual panels. Reuse payment components and the shared Modal; unsigned draft autosave remains outside the accepted scope.

**Tech Stack:** React 19, TypeScript, existing Tailwind/CSS and Holoboard UI components, nostr-tools, Vitest and Playwright.

---

## Accepted scope and working rules

Follow the [accepted design](../specs/2026-10-21-add-to-board-design.md),
[editor guide](../../../web/README.md#add-to-board) and repository-local
`holoboard-ui` and `holoboard-verify-change` skills. The skill catalog exposes the
execution skills named in the header as `subagent-driven-development` and
`executing-plans`.

Work locally on a feature branch. If this checkout contains unrelated active
work, use an isolated worktree at its reviewed source revision; read the current
product context and carry the accepted design and plan into that checkout
explicitly. Do not reset, stash or commit unrelated changes. Keep local author
and committer metadata pseudonymous before checkpoint commits. Do not push,
deploy, publish, spend funds or enable production creation as part of this plan.

Use native tools, one browser worker and fresh loopback ports. Browser fixtures
override API/relay settings and do not use real receiving or payer credentials.
Keep evidence outside the tracked source tree. Current source inspection starts
at `f7d90b4`; recheck the delta before implementation if HEAD has moved.

The visual checkpoint is approved: **A, Open layout** is the selected direction,
including the clickable HTML mock reviewed by ptrio42.
Use its open column, restrained frames and clear task progress as the baseline.
The reference image and prompt are linked from the accepted design. Keep the
approved mock's hierarchy and responsive layout when integrating the actual
components. Do not substitute B's compact composition or assume unselected
refinements were approved together with A.

The standalone [Concept A HTML mock](../../../web/prototypes/add-to-board/README.md)
is the implementation's visual reference. Its demo state is isolated from the
application and disappears on reload. Its approval covers the visual direction
and basic navigation. It does not complete any recovery,
settlement, publication or actual-component acceptance task below.

The following functional checkpoint is the local flow in the actual app, using
the existing components and representative content. Keep the accepted payment
contracts and verify recovery before treating the implementation as complete.

Review the complete journey through the user, interaction, spatial, visual,
content, accessibility and reliability perspectives in the accepted design's
evaluation section. The current spatial audit is a baseline, not approval of an
unimplemented layout. Keep expert judgments, automated checks, physical-device
observations and real participant evidence distinct.

The accepted scope now includes resuming unfinished payments after closing a
tab and returning in the same browser profile and app origin. Current refresh
tests do not establish this. Tasks R1 and R2 form a separately verified recovery
foundation before Tasks 1 to 7 change the editor. The proposed refinements under
the spec's working-prototype section remain proposals, including unsigned draft
autosave and a changed split for new account-authored posts.

Implement Tasks 2 to 4 as one integration unit after the stable composer
contract in Task 1. Progress, contextual panels and payment returns share
DirectPromote's rendering and navigation state. Keeping this change together
avoids an intermediate editor with unreachable options or mixed navigation.
Retain every checklist and verification requirement from those three tasks,
then review their combined scope for specification compliance and code quality.
The actual-component acceptance and PWA tasks remain separate execution units.

## File ownership

| File | Responsibility and planned change |
| --- | --- |
| `web/src/components/PromoteModal/BoardComposer.tsx` | Keep text/key ownership; expose review and author-details UI separately from the writing field |
| `web/src/components/PromoteModal/PromoteModal.tsx` | Pass the composer's view contract and preserve its mounted lifetime |
| `web/src/components/PromoteModal/DirectPromote.tsx` | Own editor step, contextual return points and stage-specific rendering/actions; retain invoice and attempt logic |
| `web/src/components/PromoteModal/PromotionSteps.tsx` (new) | Accessible three-stage progress and navigation to reachable earlier stages |
| `web/src/components/PromoteModal/PromotionTabs.tsx` | Remove after its editor callers are migrated |
| `web/src/components/PromoteModal/PromotionPayment.tsx` | Simplify one-recipient display; clarify two payments and return to Budget |
| `web/src/components/PromoteModal/PaymentState.ts` | Adjust editor-return copy only if required; preserve restart rules and saved shapes |
| `web/src/index.css` | Add stage-progress styles; preserve styles still used by PaymentTabs |
| `web/src/lib/paymentRecoveryStore.ts` (new) | Private transactional invoice/attempt persistence, backend provenance and initialization |
| `web/src/lib/paymentSession.ts` | Preserve its record ownership and memory fallback while adding durable save/restore |
| `web/src/lib/walletAttempts.ts`, `web/src/lib/walletPayment.ts` | Cross-tab invoice coordination and committed attempt recording before sends |
| `web/src/lib/walletAccount.ts`, `web/src/components/Wallet/WalletPanel.tsx` | Integrate the same recovery/attempt readiness and guards in Wallet Send |
| `web/src/lib/paymentSession.test.ts`, `web/src/lib/walletAttempts.test.ts`, `web/src/lib/walletPayment.test.ts`, `web/src/components/PromoteModal/paymentRecords.test.ts` | Storage failures, restored proofs, matching hashes and no-double-send contracts |
| `web/tests/boardCreation.spec.ts` | Adapt existing creation cases and add navigation/signature/guest-key regressions |
| `web/tests/payments.spec.ts` | Adapt shared navigation helpers and affected assertions; retain recovery and wallet evidence |
| `web/tests/pwa.spec.ts` | Adapt current-build navigation and add private created-post snapshot preservation |
| `README.md`, `web/README.md`, `CHANGELOG.md` | Describe implemented behavior once it exists |
| `AGENTS.md` | Already records the accepted direction; keep its lasting rules consistent with the implementation |

Reuse PromotionAmountPicker, PromotionSplit, PromotionNotePreview,
BillboardEditor, ConnectionSettings, PaymentTabs, PromotionPaymentResult and
UnfinishedPayments. Do not split unrelated payment logic merely to reduce the
line count of DirectPromote. Add another presentation component only if the
actual implementation needs an independently understandable boundary.

## State and navigation contract

Editor progress is not persisted into invoice records. Keep existing invoice
payloads compatible; put recovery metadata around them rather than changing
backend API shapes. Hydrate the private recovery cache before mounting callers
that synchronously restore payments, and expose loading/failure explicitly.
Wallet Send must await the same recovery readiness before making a send decision.
The payment object
continues to determine whether a frozen invoice or a result is shown:

```ts
type EditorStep = "post" | "budget";
type FlowStep = EditorStep | "payment";

const [editorStep, setEditorStep] = useState<EditorStep>(
    initialReference || recovered.current ? "budget" : "post",
);
const flowStep: FlowStep = payment ? "payment" : editorStep;
```

This is the integration shape, not a second invoice state machine. Preserve
the current `recovered.current?.editing` distinction, `finished` calculation,
per-recipient attempts, deferred composition and panel stack. Hide the stepper
for compact Boost and completed results. While looking up an initial post,
show loading without briefly presenting controls for an unrelated draft.

| Trigger | Required result |
| --- | --- |
| General Add to board | Blank Post stage; explicit unfinished-payment entry |
| Original pasted into general Post | Keep review and the optional comment choice, including for an active original |
| Known inactive post | Budget with its source selected |
| Explicit Boost on an active post | Current compact Boost, without the full stepper |
| Valid Post continuation | Review/sign privately if needed, then Budget; no invoices |
| Return Post to Budget without edits | Same event ID, signature and guest key; no new signer request |
| Edit content, interpretation or author before invoicing | Invalidate review and return to Post; preserve text and applicable budget |
| Prepare invoices from Budget | Freeze the exact event/draft and open Payment; no wallet send |
| Resume selected saved invoice | Payment for that invoice snapshot; method/recipient policy preserved |
| Fresh tab after the original closes | Explicit unfinished-payment list restored from private durable storage; no new invoice or send |
| Back from Payment | Budget; abort the remaining send sequence and retain invoice/attempt records |
| Older async callback | Update only its matching payment hash; never replace a newer live invoice |
| Complete payment | Existing result summary and Done; relay delivery has its own status |

All contextual panels return to the invoking step or payment method and restore
focus to their trigger. Do not reuse category-tab history as editor progress.
An account response after invoicing stays subject to deferred composition and
cannot alter the frozen payment snapshot.
Earlier-stage buttons shown during Payment must invoke the same guarded return
operation as Back to budget before changing editorStep. Setting editorStep alone
must never bypass saved-invoice or wallet-send protections.

## Task R1: Establish private invoice recovery after tab closure

**Files:** Create paymentRecoveryStore.ts; modify paymentSession.ts,
paymentRecords.ts, PromoteModal.tsx and their existing unit/browser tests.

- [x] Add a browser case that issues a guest invoice, closes its page and opens
  a fresh page in the same browser context. Do not copy sessionStorage to it.
  Select the saved payment explicitly and assert its event, hash, QR/open/copy
  values and invoice-request count are unchanged. Run it against the current
  implementation to observe the missing recovery record.
- [x] Add a private IndexedDB-backed store using the documented transaction
  lifecycle. Keep invoices, archived records and shared attempts distinct from
  public read caches and the publication outbox. Preserve exact signed snapshots
  and backend provenance. Do not store guest keys or wallet/signer credentials.
- [x] Expose initialization readiness and await it before synchronous cache
  readers select records. Keep memory fallback for unavailable/full storage;
  show its limited lifetime without blocking anonymous invoice open/copy/QR.
- [x] Investigate legacy-record provenance with a focused fixture before
  importing old sessionStorage records. Preserve legacy originals and avoid
  silently assigning an unverifiable invoice to the current backend. Document
  and test the import policy; do not delete original records during import.
  This is browser-format compatibility, not a migration of deployed server data.
- [x] Make hash-scoped updates transactional. A late response may update its
  archived invoice but cannot replace another invoice or the current selection.
  Keep unresolved/uncertain records despite expiry; do not silently evict them.
- [x] Add backend-isolation, malformed-record, storage-failure and fresh-page
  tests. Verify restored content stays private and no signature, publication,
  connection or invoice request occurs simply from restoration.
- [x] Run the focused storage/record tests and fresh-tab browser case. Commit
  with `Persist unfinished invoices for same-device recovery`.

## Task R2: Preserve shared wallet-attempt safety across tabs and restarts

**Files:** paymentRecoveryStore.ts, walletAttempts.ts, walletPayment.ts,
walletAccount.ts, WalletPanel.tsx, DirectPromote.tsx and relevant wallet tests.

- [x] Extend the recovery fixture with an uncertain send, page closure and
  return. Add two tabs competing to send the same invoice, including promotion
  in one and Wallet Send in the other. Assert one send at most, with original
  wallet identity and payment hashes retained. A same-page Set is insufficient.
- [x] Use the standard Web Locks API to coordinate by payment hash across the
  two callers. Re-read the durable attempt while holding the lock before
  deciding whether to look up or send. Save and await the uncertain-attempt
  transaction before invoking wallet.sendPayment.
- [x] Integrate the async persistence boundary in payInvoiceSafely and both
  callers. Await submitted proof writes as well. A pending write, storage error,
  missing coordination capability or unknown prior attempt must not authorize
  another wallet send. Keep anonymous invoice methods available in these states.
- [x] Re-verify restored preimages. Refresh shared snapshots on external writes
  without regressing confirmed, reported or uncertain records to unpaid. The
  transactionally stored state is authoritative; notifications only request a
  refresh. Keep local busy indicators and original-wallet lookup rules.
- [x] Test tab closure while a request is pending, after a committed attempt
  but before sending, and after sending without a response. No response is a
  retained unknown state until lookup or explicit existing recovery resolves it.
- [x] Run the unit wallet/attempt tests, promotion-versus-Wallet Send browser
  cases and new cross-tab cases sequentially. Include the supported phone
  engine for the fresh-page and coordination cases.
- [x] Commit with `Coordinate recoverable wallet attempts across tabs`. Use
  this committed foundation as the pre-redesign rollback baseline for Task 6.
  Older tab-only builds retain their historical in-session compatibility scope;
  do not claim fresh-tab recovery while running code that cannot read the store.

## Task 1: Expose composer continuation without changing payment ownership

**Files:** BoardComposer.tsx, PromoteModal.tsx, DirectPromote.tsx,
web/tests/boardCreation.spec.ts.

- [x] Extend the existing guest and account fixtures to count signer requests
  and record reviewed event IDs while retaining their existing frozen-snapshot
  assertions. Repeated review through navigation becomes observable in Task 2;
  do not add a test requiring a second Review post button that does not exist.
- [x] Run the guest, original/quote and late-sign-in creation cases with creation
  and signer flags enabled, using the command pattern under Verification. Record
  their baseline requests and saved IDs before changing the composer contract.
- [x] Change the composer render prop to expose this contract, updating all
  actual callers together so TypeScript remains buildable:

```ts
export interface BoardComposerView {
    editor: ReactNode;
    authorDetails: ReactNode;
    canContinue: boolean;
    busy: boolean;
    review: () => Promise<BoardComposition | null>;
}
```

- [x] Make review return the current verified private event, or the selected
  original reference, on success and null on failure. Preserve signature-payload
  validation, version checks and cancellation. Reuse an unchanged reviewed
  event; create a new guest key only when preparing changed content requires it.
- [x] Keep edit/account invalidation notifications flowing through onSource.
  Keep DirectPromote's deferred-composition guard while preparing or showing
  invoices. Accept the returned source directly for stage continuation instead
  of depending on the timing of a React effect.
- [x] Separate author details and key export from the writing field. Retain the
  guest-key warning, including replacement after an edited review. Keep the
  composer owner mounted through Budget, Payment and contextual panels.
- [x] Rerun the focused creation cases. Check that an old signed invoice never
  contains or depends on a guest secret. Commit the reviewed task files with
  `Expose stable composer review for guided navigation`.

## Task 2: Add Post and Budget navigation with one primary action per stage

**Files:** Create PromotionSteps.tsx; modify DirectPromote.tsx, PromoteModal.tsx,
index.css and boardCreation.spec.ts.

- [x] Adapt the guest browser case to assert that initial Post has no amount
  picker, split or invoice action. Add `Review & continue`, then assert Budget
  shows the exact reviewed post and no longer shows the editable textarea.
- [x] Add Post-to-Budget-to-Post-to-Budget assertions, including unchanged
  signer count and guest event ID. Inspect outgoing requests: this sequence
  must create zero invoices and zero publication frames.
- [x] Implement editor progress using the state contract above. For Post,
  render the composer or the existing-post input and its preview. For Budget,
  render the existing preview, amount controls and recipient allocation.
  A new composition effect with the same effective source is idempotent and
  must not undo successful continuation or reset the budget.
- [x] Implement PromotionSteps as a navigation region containing an ordered
  list of Post, Budget and Payment. Announce the current step with aria-current;
  completed reachable steps use real buttons, future unavailable steps are
  noninteractive and have a visible prerequisite explanation. Do not add tab
  roles to sequential progress. PaymentTabs keeps its existing tab semantics.
- [x] Put Review & continue in the fixed Post footer, with paid-publication
  information and conditional signer explanation. Disable it for empty/invalid
  content or active review. An original must finish verified preview loading
  before continuation; loading and source errors remain actionable in Post.
- [x] Give Budget an Edit post action and `Continue to payment · {total} sats`.
  Preserve the current invoice-preparation handler and all its validity guards.
  Display the complete total and `Creates invoices. No payment is sent yet.`
- [x] Present guest authorship in plain language with optional Nostr sign-in.
  With creation disabled, show only `Post link` and existing-post guidance;
  hide writing, guest-creation and Add a comment controls while preserving
  previously issued creation invoices. The title stays Add to board.
- [x] Verify focus moves to the new stage heading, keyboard navigation works,
  source changes invalidate review and known inactive posts skip initial writing.
  Keep Boost unchanged. Run the focused guest case, the original/quote case and
  one creation-disabled existing-post case. Commit with
  `Guide Add to board through post and budget stages`.
- [x] Inspect the first functional composition at a normal phone and desktop
  width before polishing optional panels. Compare the same short linked post
  used by the baseline audit. Check whether Post still duplicates a tall editor
  and preview, and whether step progress or summaries consume the space saved.

## Task 3: Place optional controls at the decisions they affect

**Files:** DirectPromote.tsx, PromotionTabs.tsx, index.css,
boardCreation.spec.ts and payments.spec.ts.

- [x] Add a Budget regression selecting a custom amount, a changed author split,
  Billboard and notifications. Traverse appearance, options, help and account
  panels, then assert every choice and the complete total survive. Check the
  invoice request contains the exact selected notification identity, split and
  appearance, with no payment sent.
- [x] Replace the disabled guest split with `All of this amount goes to
  visibility.` Keep both amounts, percentages, two-color slider and campaign
  reset together for eligible original posts. Preserve visibility-only and
  missing-address versus temporary-outage behavior.
- [x] Add a quiet Billboard entry showing the actual optional fee on Budget.
  Preserve the current appearance editor, source-derived fragments and preview.
  Keep an explanatory Billboard entry in Post before a source is ready; after
  loading, editing follows the existing start/revival eligibility rules.
- [x] Keep an optional Payment options entry on Budget with explicit
  Notifications controls before invoice creation. Hide guest-inapplicable
  controls. Keep public-author-zap consent beside the split and preserve signer
  session checks. Place wallet connection on the payment Wallet method.
- [x] Give contextual panels explicit invoking-step and focus-return behavior.
  Budget panels retain the full total and preparation action. Preparation errors
  return to the relevant Budget control; an invalid notification identity opens
  Notifications with the draft intact.
- [x] Update payment-test helpers such as backToForm, openPaymentOptions,
  openConnections and prepareInvoices to use stage/context navigation. Preserve
  each test's original payment assertions and amount expectations; never weaken
  a recovery assertion to make a renamed control pass.
- [x] Remove PromotionTabs after checking all references. Keep promotion-tabs
  and promotion-tab CSS still used by PaymentTabs; remove only editor-specific
  dead styling. Run the contextual-options case, author-outage case and quick
  Boost layout cases. Commit with `Make promotion extras contextual`.

## Task 4: Finish the Payment stage and preserve invoice navigation

**Files:** DirectPromote.tsx, PromotionPayment.tsx, PaymentState.ts,
payments.spec.ts and boardCreation.spec.ts.

- [x] Add one-recipient and split-invoice assertions: account-free open/copy/QR
  remain usable, one recipient has no redundant selector, and two recipients
  show their individual amounts and statuses. Existing method selection and
  remembered-wallet ordering remain unchanged.
- [x] Render stage progress together with PaymentTabs in the shared navigation
  host for the full flow. Hide stage progress in Boost and completed results.
  Show the frozen post and complete total without reintroducing editing there.
- [x] Replace only the redundant single-recipient control with a static amount
  and status. Add the two-payment explanation when author support exists. Keep
  original invoice hashes, copy values, QR payloads, replacement actions and
  manually reported/unverified distinctions unchanged.
- [x] Expose Back to budget for the full flow and keep the compact return label
  appropriate for Boost. Route it through the existing backToPromotion operation
  and then set editor progress to Budget. Do not clear invoice records or shared
  wallet attempts. Ensure late wallet enable/response callbacks cannot continue
  a send sequence after this navigation.
- [x] After this return, place a visible Resume entry with the frozen total
  above the budget form. Check it at phone widths so the fixed preparation
  action does not hide the way back to an already issued invoice.
- [x] Preserve existing partial and completed result handling. Use Done to close
  the result and keep created-post publication status separate from settlement.
  Completing or navigating a payment does not silently start another invoice.
- [x] Run targeted account-free split, partial recovery, pending WebLN return,
  uncertain NWC and older-invoice-callback cases. Check both request counts and
  saved payment hashes. Commit with `Integrate guided payment and recovery`.

## Task 5: Exercise the actual local flow on phones and desktop

**Files:** boardCreation.spec.ts, payments.spec.ts; affected components and
index.css only for defects exposed by these checks.

- [x] Extend the existing creation cases for guest-only operation with signer
  UI disabled, then for enabled Nostr sign-in, rejected/changed signatures,
  original versus quote, edited content and late sign-in while invoices exist.
  Guest-only checks must run rather than be skipped by the signer flag.
- [x] Capture Post, Budget, optional appearance and Payment at 320, 390 and 1280
  CSS pixels with the same short/long text and ordinary link fixtures. Add one
  small-phone case with long note content and one with long author identity.
- [x] Assert the expected count of matched actions before checking their
  geometry. Check fixed-footer visibility, horizontal overflow, native custom
  input clearing, real note links, accessible stage names and error placement.
- [x] Record usable text width, title/navigation/footer heights, visible body
  height and scrolling needed to reach required choices. Compare settled frames
  after resize, including the 768px breakpoint. Keep only relevant compact
  summaries and avoid hiding important explanations to improve these numbers.
- [x] Review hierarchy and grouping with the current pixel typography and neon
  palette. Measure actual text/control contrast and effective hit areas rather
  than inferring them from token names. Check font enlargement, reflow and
  focused controls near the fixed footer. The 44px project touch target is not
  the same claim as WCAG's 24px AA minimum with exceptions.
- [x] Check focus return from help, author-key export and connection panels.
  Use WebKit for the focused touch/keyboard/focus cases. Inspect a real phone's
  virtual-keyboard behavior manually if available; otherwise record that gap.
- [x] Rerun the existing compact Boost width cases and connected-wallet manual
  invoice case. Keep the normal-phone default Boost free of scrolling.
- [x] Inspect the result visually and fix demonstrated issues. Do not infer
  improved conversion from fewer controls or clicks. Commit with
  `Cover guided contribution navigation and responsive states`.
- [x] Run an agent-led task walkthrough of the actual prototype: a guest sharing
  an ordinary link, promotion of someone else's original, an explicit quote,
  changed budget/appearance with Back, compact Boost, and unfinished/uncertain
  payment recovery after tab closure. Give goals rather than a prescribed click
  sequence. On the first attempt, use visible labels and help, with no source
  code serving as navigation instructions.
- [x] Record each goal, attempted route, outcome, friction, severity and screenshot
  or state evidence. Verify attribution, recipients and the next action. Fix
  demonstrated defects and repeat the affected tasks; do not mark unimplemented
  behavior as passed. Provide the prototype and report for ptrio42's separate
  assessment. Recruiting other participants is optional follow-up, not a gate
  for this pass. Keep physical-device gaps distinct from browser task findings.

This is the first reviewable local product checkpoint: the complete three-stage
flow, its optional controls and compact Boost can be demonstrated with fixtures.
Review it using the accepted criteria rather than reopening settled choices.

## Task 6: Preserve created-post invoices through PWA update and rollback

**Files:** web/tests/pwa.spec.ts; existing fixture helpers only if needed.

- [x] Inspect the existing PWA fixture's baseline-label assumptions before
  changing helpers. Use separate baseline and candidate navigation adapters:
  the baseline build can still have category tabs and old preparation labels.
- [x] Add a creation-enabled fixture preparing a private guest post. Verify its
  signed event snapshot and issued invoice survive update, creation-off rollback
  and re-enabling. Recover and pay that issued invoice in the mock API; new
  creation stays unavailable in the rollback build. No guest secret is persisted.
- [x] Add a real tab close and fresh-page reopen during the compatible-baseline
  rollback cycle. Retain actual service-worker activation, API transport, decoded QR,
  clipboard and open-in-wallet checks. A route-only mock with service workers
  blocked does not substitute for this test.
- [x] Build the committed pre-redesign and candidate frontends sequentially
  using the local mock settings and isolated dist paths documented in
  web/README.md. The baseline includes the R1/R2 recovery foundation. Set creation
  explicitly for each candidate; do not use the
  Pages production profile to activate it.
- [x] Run the new created-post PWA case first on desktop, then on the phone
  engine required by any failure or focus/worker concern. Record exact source
  revisions and built paths. Keep broader release-matrix gaps explicit; remove
  the AGENTS.md outstanding-acceptance note only when all its named gaps have
  revision-specific passing evidence.
- [x] Commit the reviewed test with
  `Preserve created-post invoices across guided-flow rollback`.

## Task 7: Update current-behavior documentation and hand off the local build

**Files:** README.md, web/README.md, CHANGELOG.md and AGENTS.md if evidence
actually closes its outstanding acceptance gates.

- [x] Replace implemented editor-tab descriptions with Post, Budget and Payment
  in the existing user/developer guides. Describe the plain-link/guest path only
  with its real feature availability. Keep setup and account recovery details in
  their current linked documents.
- [x] Add one concise Unreleased changelog entry grouping the guided flow and
  contextual options. Do not mark it released before a confirmed deployment.
- [x] Run targeted unit checks, changed-file lint and one candidate build as
  listed below. Reuse unaffected evidence; do not run unrelated reader/backend
  suites or container builds without an identified dependency risk.
- [x] Review the full implementation diff, privacy and unpublished commit
  metadata. Confirm no production flags, backend invoice API schemas, external publication
  rules or unrelated working files changed. Commit with
  `Document the guided Add to board flow`.
- [x] Provide the runnable local preview, representative screenshots, source
  revision and verification report. Distinguish passing local mocks from real
  wallet/device interoperability and observed usability. Production activation,
  deployment and public release remain separate authorized actions.

## Verification commands

Run commands from `web/`, sequentially. Use a different free test port if the
listed one is already owned. The Playwright config supplies mock-only API/relay
URLs and overrides the creation/sign-in flags. Name selections must correspond
to the described behavior after the tests are adapted.

Focused creation/signature and navigation checks:

```bash
VITE_ENABLE_POST_CREATION=true VITE_ENABLE_NOSTR_CONNECT=true \
HOLOBOARD_TEST_PORT=4191 CI=1 npm run test:e2e -- \
  tests/boardCreation.spec.ts --project=desktop --workers=1
```

Guest-only mode, followed by creation-disabled account-free payments:

```bash
VITE_ENABLE_POST_CREATION=true VITE_ENABLE_NOSTR_CONNECT=false \
HOLOBOARD_TEST_PORT=4192 CI=1 npm run test:e2e -- \
  tests/boardCreation.spec.ts --project=desktop --workers=1 --grep 'guest'

VITE_ENABLE_POST_CREATION=false VITE_ENABLE_NOSTR_CONNECT=false \
HOLOBOARD_TEST_PORT=4193 CI=1 npm run test:e2e -- \
  tests/payments.spec.ts --project=desktop --workers=1 \
  --grep 'anonymous split invoices|anonymous single-invoice|quick boost fits'
```

Invoice/state regressions selected for the changed return transitions:

```bash
VITE_ENABLE_POST_CREATION=true VITE_ENABLE_NOSTR_CONNECT=true \
HOLOBOARD_TEST_PORT=4194 CI=1 npm run test:e2e -- \
  tests/payments.spec.ts --project=desktop --workers=1 \
  --grep 'customization, contextual help|author wallet issues|partial payment can return|returning while WebLN|NWC recovers a paid author invoice after a lost response|preparing another payment for the same note|late wallet response cannot overwrite'
```

Use `--list` before larger selections. Re-run only the relevant new phone/focus
cases with `--project=iphone`, not every browser project by default. Expected:
all selected cases run and pass; unexplained skips or missing grep matches are
not success. Preserve original no-double-charge and recipient-value assertions.

Focused existing unit contracts and changed frontend lint:

```bash
npm run test -- src/lib/boardComposer.test.ts src/lib/paymentSession.test.ts \
  src/components/PromoteModal/paymentRecords.test.ts \
  src/lib/walletAttempts.test.ts src/lib/walletPayment.test.ts --maxWorkers=1

npx eslint src/components/PromoteModal/BoardComposer.tsx \
  src/components/PromoteModal/PromoteModal.tsx \
  src/components/PromoteModal/DirectPromote.tsx \
  src/components/PromoteModal/PromotionSteps.tsx \
  src/components/PromoteModal/PromotionPayment.tsx \
  src/components/PromoteModal/PaymentState.ts \
  src/lib/paymentRecoveryStore.ts src/lib/paymentSession.ts \
  src/lib/walletAttempts.ts src/lib/walletPayment.ts src/lib/walletAccount.ts \
  src/components/Wallet/WalletPanel.tsx \
  tests/boardCreation.spec.ts tests/payments.spec.ts tests/pwa.spec.ts
```

Build the candidate with explicit local endpoints. Choose a fresh output
directory; this command is an example for the candidate build, not a deployment:

```bash
VITE_API_URL=http://127.0.0.1:3334 \
VITE_RELAY_URL=ws://127.0.0.1:3334 VITE_PUBLIC_RELAYS=ws://127.0.0.1:3334 \
VITE_SATS_ENDPOINT=http://127.0.0.1:3334/api/board \
VITE_ENABLE_POST_CREATION=true VITE_ENABLE_NOSTR_CONNECT=true \
VITE_ENABLE_DISCUSSIONS=false VITE_ENABLE_PROFILES=false \
VITE_ENABLE_REPLY_PUBLICATION=false \
npm run build -- --outDir /tmp/holoboard-guided-flow-candidate
```

For Task 6, build the committed R1/R2 foundation baseline and creation-off candidate into
separate fresh directories with the same endpoints. Extend pwa.spec.ts with the
test name `created-post PWA update and rollback preserve the signed invoice` and
the environment inputs `HOLOBOARD_CREATION_DIST` (creation-enabled candidate),
`HOLOBOARD_CREATION_OFF_DIST` (same candidate with creation off), and
`HOLOBOARD_ROLLBACK_DIST` (committed recovery-capable pre-redesign baseline). Then run:

```bash
HOLOBOARD_CREATION_DIST=/tmp/holoboard-guided-flow-candidate \
HOLOBOARD_CREATION_OFF_DIST=/tmp/holoboard-guided-flow-creation-off \
HOLOBOARD_ROLLBACK_DIST=/tmp/holoboard-guided-flow-baseline \
HOLOBOARD_TEST_PORT=4195 CI=1 npm run test:e2e -- \
  tests/pwa.spec.ts --project=desktop --workers=1 --grep 'created-post PWA'
```

The new environment inputs are part of Task 6, not features of the current test.
Expected: an actual prepared private-post invoice remains usable through the
candidate/rollback cycle and no new invoices or wallet sends happen merely from
navigation or worker activation. Preserve existing legacy/readers/enabled cases.
