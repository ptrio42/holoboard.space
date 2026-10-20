# Discovery Fund Implementation Plan

> **For agentic workers:** Use subagent-driven development for isolated implementation tasks and review the integrated result before completion.

**Goal:** Discover worthwhile public Nostr posts across topics, offer seven days in Waiting room New, and reward authors from an independently budgeted NWC wallet.

**Architecture:** The Go backend collects signed candidates and owns admission, durable reward records and wallet execution. A local TypeScript runner uses Codex app-server with ChatGPT subscription authentication to submit bounded editorial decisions. Discovery rewards never become promotion ledger payments.

**Tech Stack:** Existing Go relay/storage/Nostr transport, React/TypeScript, Node.js, Codex JSON-RPC over stdio, NIP-47 and NIP-57.

## Accepted behavior

- Disabled by default; independent collection, dry-run and active modes. Seven days of dry-run evidence precede explicit activation, and the active pilot lasts thirty days.
- At most three discoveries and 1000 reward sats daily, with tiers 21/100/500. Unresolved reservations carry into subsequent days. Fees are reported separately.
- At most one discovery per author in thirty days and one Bitcoin/Nostr item in every five consecutive discoveries. Broad topics and languages; underexposure is based only on observed sources.
- Mixed New is opt-in through include_discoveries=true. Rank, Hot, TOP 21 and old API callers retain paid-only behavior. Discovery-first exposure survives later promotion without becoming new twice.
- No Lightning support does not exclude an author. Missing support becomes unavailable without a promised reward. No automatic quote or unsolicited DM is introduced.
- Post content is untrusted input; the model cannot execute commands, read wallet secrets or choose payment recipients/invoices.

## Task 1: Durable backend discovery and feed

Files: new relay/curator*.go and tests; extend relay/storage.go, relay/campaign.go and relay/waiting_updates.go.

- [x] Add bounded verified candidate storage, issued batches, idempotent decision results and permanent discovery/reward history to atomic storage snapshots.
- [x] Add curator-token candidates/decisions/status APIs and separate admin mode control. Reject unknown candidates, malformed decisions, replay conflicts, expired batches, removed/promoted events and admission limits atomically. Older worthwhile events remain eligible.
- [x] Collect recent streams, rotating search topics, old relevant windows, reference hints and author outboxes through existing safe relay dial budgets. Store partial coverage honestly.
- [x] Merge active discoveries into opt-in New, preserving first exposure through promotion. Return waiting counts for discovery-only waiting rooms and opt-in update IDs.
- [x] Test persistence failure, restart, concurrency, caps, duplicates, expiry, conversion and backward compatibility with native Go tests.

## Task 2: Reward execution and application wiring

Files: new relay/curator_rewards.go, relay/curator_nwc.go and tests; extend relay/main.go and relay/.env.example.

- [x] Prepare author-bound signed zap requests and validate exact invoice amount, network, description hash and expiry using existing LNURL safety rules.
- [x] Persist reservations and invoice/wallet/recipient snapshots before sends. Claim an attempt durably before network execution. Unknown outcomes reconcile the same hash and cannot produce another send.
- [x] Reconcile with preimages or matching outgoing wallet records, retaining protections across restarts, pause and wallet changes. Author receipts alone do not prove the backend spent funds.
- [x] Wire disabled-by-default settings and independent reward NWC credentials. Require explicit activation after dry-run and stop new admissions/sends after pilot expiry.
- [x] Test with fake wallets and LNURL providers only; never make real payments or production publications during implementation.

## Task 3: Waiting room presentation

Files: web/src/lib/campaigns.ts, waitingUpdates.ts, components/BoardRow/NoteCard.tsx, pages/Billboard.tsx, relevant reading presentation types and tests.

- [x] Parse discovery entries without inventing paid rank, amounts or weight. Opt the board UI into discovery metadata without changing profile promotion queries.
- [x] Show discovery origin, concise reason, reward status and expiry using existing pixel controls. Preserve presentation through reading navigation and anonymous promotion.
- [x] Update waiting counts, newness and help, including discovery-only waiting rooms. Test legacy API responses and mixed/discovery-only New in unit/browser fixtures.

## Task 4: Local Codex runner

Files: new curator/ TypeScript package, policy/schema, mock app-server tests and operator guide.

- [x] Use a dedicated stdio app-server child with managed ChatGPT login. Strip inherited secrets, disable tools and reject server tool/approval requests. Require known absence of available paid credits and an operator declaration that auto-reload and overage billing are disabled; document that the native protocol cannot reserve included usage atomically.
- [x] Send fresh structured candidate batches and validate constrained decisions. Reject API-key auth, exhausted limits, malformed/truncated output and unknown IDs.
- [x] Persist at most two daily rounds of fifty candidates, including failed evaluations and ambiguous submissions. Retry an uncertain backend submission with the same ID before another model call. No catch-up or paid API fallback.
- [x] Provide run-once/check/watch modes and macOS scheduling instructions without installing or enabling external services.
- [x] Test protocol handshake, output, auth/limits, hostile content handling, restart, schedule and submission recovery using local fakes.

## Task 5: Integration and documentation

- [x] Document API/configuration in relay/API.md and relay/README.md, behavior in docs/nostr.md, product changes under CHANGELOG.md Unreleased and durable local instructions.
- [x] Run the maintained verification runner with readers/payments/backend profiles as appropriate, focused new tests, native build and local browser acceptance.
- [x] Review spec coverage and code quality, fix findings and rerun affected checks. Report live subscription and real-wallet acceptance as unperformed unless separately authorized.
- [x] Transfer only task-owned changes to the original checkout on a feature branch, preserving pre-existing edits. Do not push, deploy or publish.
