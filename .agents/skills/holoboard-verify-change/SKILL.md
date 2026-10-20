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

## Choose checks from the delta

Identify the last verified revision and what changed since it. Reuse its evidence
for unchanged behavior; a merge, local commit or branch switch alone does not
require repeating the full matrix. Check the integrated result where dependencies
or conflict resolutions can change behavior.

| Change | Usual acceptance scope |
| --- | --- |
| Documentation or nonfunctional copy | Review the diff and references; check wrapping only when visible text changes. |
| Isolated CSS or component layout | Inspect the affected widths and a few relevant browser cases. Run changed TypeScript lint when applicable and one build when compilation or CSS generation needs checking. |
| Shared note or reader layout | Check representative media/text combinations, the changed placement cases and affected reader handoffs. Use the browser engines needed for those risks. |
| Account, wallet, payment or durable state | Run regressions for the changed transitions and relevant anonymous-payment, recovery or rollback contracts. |
| Shared protocol library, dependencies or build configuration | Broaden to affected unit suites, builds and browser contracts. |
| Release verification or an integration with unknown coverage | Use the broader matrix, identifying the gaps it closes. |

Choose tests by behavior, not only by touched directory. A test that already
iterates through phone and desktop widths does not automatically need every
device project. Include WebKit for touch, focus or Safari-specific behavior;
use multiple engines when the change can behave differently between them.
Do not rerun backend checks for a frontend-only delta.

For a sizable browser selection, inspect `playwright test --list` or prior report
counts before execution. Explain the reason for a long run before starting it.
Escalate from targeted checks when they expose a concrete concern, coverage is
unknown, or the change crosses a high-risk contract. Routine visual edits do not
need a full suite merely because the suite exists.

## Select checks

Use the runner in `scripts/verify_change.py` to inspect the available plan.
Profiles are additive and describe broad candidate checks:

| Profile | Local checks |
| --- | --- |
| `frontend` | Changed TypeScript lint, unit tests, default build, default feature gates, anonymous split invoices and signed-out header. |
| `readers` | Frontend checks, read-only build, discussion/profile/pointer/notes navigation suites and socket budgets. |
| `payments` | Frontend checks, enabled-feature build, account header, payment, wallet and board-update fixtures. |
| `publication` | Frontend checks, enabled-feature build, account header, reply/signing and durable public-outbox fixtures. |
| `backend` | Go race checks including the nested retained Nostr module; optional explicit upstream provenance input. |

Choose profiles from the diff and affected contracts. Shared note presentation
usually needs `readers`; promotion or payment state needs `payments`; changes to
signing, publishing or retry receipts need `publication`. Include `backend` for
Go, API or retained-module changes. Combine profiles for shared dependencies and
integrated visual checkpoints. Select stages with `--only` instead of executing
every profile stage by default. When a stage still includes unrelated behavior,
run a narrower Playwright file/name/project selection directly, retaining the
runner's explicit mock URLs, feature flags, fresh port and one worker. Preserve
reports and source checks. Review whether additional checks are necessary;
the profiles are a starting matrix, not an exhaustive dependency graph.

```bash
python3 <skill-dir>/scripts/verify_change.py --repo <checkout> \
  --profile readers --base <comparison-ref>
```

This prints a plan and saves `report.json` in a fresh temporary directory.
Execute the selected plan with `--run`, without requesting another confirmation
for already authorized local verification. Use `--protect-worktree <path>` when
another checkout must remain unchanged. The runner does not stash, reset, commit,
install packages, start Docker, contact production smoke endpoints or deploy.
Protect stable checkouts, not a visual checkout under active development. Verify
the imported commit in the target branch while preserving concurrent work.

Outputs and build artifacts stay outside the source checkouts. Browser stages
use fresh Vite servers, explicit flags, loopback mock endpoints and one worker.
Browser stages stop at their first failure so diagnosis precedes another full run.
The runner admits one stage at a time and limits unit workers. It does not reuse
an existing preview or inherit application credentials from the parent process.
Vite may load existing checkout environment files; mock URLs and feature flags
are explicitly overridden. Do not copy real-wallet environment files into test checkouts.

For release preparation or changes to `web/vite.config.ts` or the production
feature profile, add `--pages-production` with a frontend profile. The extra
`build-pages-production` stage simulates Pages on `main`, supplies all four
ordinary feature flags as false, and lets `web/production-features.json` override
them. It checks the generated HTML revision and whether the compiled Reply
chunk matches the profile, recording both in `report.json`. It uses loopback
mock URLs and makes no deployment. This build does not establish runtime
behavior of every flag or validate deployed origins; retain the relevant
browser suites and post-deployment checks. Ordinary invocations omit the stage.

For payment/PWA changes or release preparation, provide appropriate prebuilt
mock-backend baselines. `--legacy-dist <path>` adds the old-invoice update check;
`--rollback-dist <path>` adds reader update and code rollback, using the runner's
fresh read-only build. Identify baseline revisions in the final evidence. Do not
substitute an arbitrary old build or call a Git baseline the currently deployed
artifact without deployment evidence.
With `payments` or `publication` selected, the rollback input also adds an enabled
PWA check. It preserves anonymous invoices and unsigned reply drafts through
update, rollback and re-enabling, without connecting a signer or publishing.

For retained-module updates, add `--nostr-upstream <downloaded-module-path>`.
The existing provenance verifier checks the pinned manifest and patch. Missing
baseline/provenance inputs are reported as unperformed checks, not successes.
Consult the maintained release gates when those checks are required by the change.

## Interpret results and finish

Inspect each stage's log and machine-readable report. A browser process exiting
successfully with no passing tests is a failure. Skips remain visible. Read the
browser report's counts, including failed and unperformed cases, rather than
inferring coverage from progress output. A nonzero
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
