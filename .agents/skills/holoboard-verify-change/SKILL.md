---
name: holoboard-verify-change
description: Select and run local acceptance checks for Holoboard feature changes, visual integration, dependency updates and release preparation. Use when verifying Holoboard changes or a combined checkpoint; ordinary edits alone do not require the full matrix.
---

# Verify a Holoboard change

Choose evidence appropriate to the changed behavior, execute it in the intended
checkout, and report what passed and what remains unverified. Keep routine
verification autonomous within the user's authorized scope.

## Establish the scope

Locate the actual checkout with Git. Read its `AGENTS.md` and linked collaboration
instructions. Inspect the diff, including staged and untracked work. When checking
committed work, choose an explicit comparison base from the agreed checkpoint or
merge base; do not assume another branch's current HEAD was the verified baseline.
Keep existing work intact and keep unrelated production work independent.

Read the relevant maintained contracts instead of copying their rules here:

- `docs/nostr.md`: reads, hints, cache, transport, budgets, publication and release gates.
- `docs/nostr-discussions.md`: original promoted focus, protocol relationships and paid/unpaid branches.
- `web/README.md`: promotion, anonymous invoices, wallet recovery and browser checks.
- `relay/DEPLOYMENT.md`: backend compatibility, production identity, ledger, release and rollback.

For protocol or library changes, inspect the installed dependency implementation
and authoritative specifications. Local mocks establish fixture behavior, not
physical Amber compatibility or delivery through independent public clients.

## Select checks

Use the runner in `scripts/verify_change.py`. Profiles are additive:

| Profile | Local checks |
| --- | --- |
| `frontend` | Changed TypeScript lint, unit tests, default build, default feature gates and anonymous split invoices. |
| `readers` | Frontend checks, read-only build, discussion/profile/pointer/notes navigation suites and socket budgets. |
| `payments` | Frontend checks, enabled-feature build, payment, wallet and board-update fixtures. |
| `publication` | Frontend checks, enabled-feature build, reply/signing and durable public-outbox fixtures. |
| `backend` | Go race checks including the nested retained Nostr module; optional explicit upstream provenance input. |

Choose profiles from the diff and affected contracts. Shared note presentation
usually needs `readers`; promotion or payment state needs `payments`; changes to
signing, publishing or retry receipts need `publication`. Include `backend` for
Go, API or retained-module changes. Combine profiles for shared dependencies and
integrated visual checkpoints. Review whether additional checks are necessary;
the runner's profiles are a starting matrix, not an exhaustive dependency graph.

```bash
python3 <skill-dir>/scripts/verify_change.py --repo <checkout> \
  --profile readers --base <comparison-ref>
```

This prints a plan and saves `report.json` in a fresh temporary directory.
Execute the selected plan with `--run`, without requesting another confirmation
for already authorized local verification. Use `--protect-worktree <path>` when
another checkout must remain unchanged. The runner does not stash, reset, commit,
install packages, start Docker, contact production smoke endpoints or deploy.

Outputs and build artifacts stay outside the source checkouts. Browser stages
use fresh Vite servers, explicit flags, loopback mock endpoints and one worker.
The runner admits one stage at a time and limits unit workers. It does not reuse
an existing preview or inherit application credentials from the parent process.
Vite may load existing checkout environment files; mock URLs and feature flags
are explicitly overridden. Do not copy real-wallet environment files into test checkouts.

For payment/PWA changes or release preparation, provide appropriate prebuilt
mock-backend baselines. `--legacy-dist <path>` adds the old-invoice update check;
`--rollback-dist <path>` adds reader update and code rollback, using the runner's
fresh read-only build. Identify baseline revisions in the final evidence. Do not
substitute an arbitrary old build or call a Git baseline the currently deployed
artifact without deployment evidence.

For retained-module updates, add `--nostr-upstream <downloaded-module-path>`.
The existing provenance verifier checks the pinned manifest and patch. Missing
baseline/provenance inputs are reported as unperformed checks, not successes.
Consult the maintained release gates when those checks are required by the change.

## Interpret results and finish

Inspect each stage's log and machine-readable report. A browser process exiting
successfully with no passing tests is a failure. Skips remain visible. A nonzero
command or changed source snapshot stops execution and preserves the report;
remaining stages are unperformed. A protected checkout changing during a run
may reflect concurrent work. Inspect it and preserve it rather than reverting it.

Investigate a failure before retrying. Check feature flags, checkout, port,
fixture lifecycle and local contention before changing product behavior or
loosening limits. Use `--only <stage-name>` to rerun selected stages after a
justified correction; this creates a separate report and does not mark omitted
stages passed. Recheck affected acceptance after integrating another branch.

Complete additional authorized checks that the diff or release contract needs,
such as production-configuration builds, resource fixtures or controlled live
reads. Docker is appropriate when container behavior needs evidence. Actual
publication, funds, deployment and external settings follow the existing session
authorization and repository instructions; the skill grants no extra permission.

Report the checkpoint and comparison base, selected profiles, concrete results,
expected skips, unresolved failures and relevant checks not performed. Separate
confirmed defects from hypotheses. Passing local stages alone is not a release
approval. Update the existing contract or changelog when behavior changes; avoid
creating a session chronicle or duplicating repository instructions in this skill.
