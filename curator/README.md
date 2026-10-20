# Local discovery curator

A local Node 24+ runner that uses an existing managed ChatGPT login through
Codex App Server. It evaluates a bounded public sample for Holoboard's discovery
fund. The backend verifies events, applies admission and budget rules, and owns
publication and wallet credentials. The model receives post material and editorial
rules, never a backend bearer, NWC connection or wallet action.

## Install and check

Install native Codex CLI **0.163.0** and sign in with ChatGPT through its normal
login flow. Other versions fail with `codex_version_requires_tool_audit`; update
support only after reviewing protocol/tool changes and rerunning the native audit.

```sh
cd curator
npm ci
npm run check
npm test
npm start -- --check
```

`--check` validates the installed version, its bundled model catalog, isolated
configuration, managed ChatGPT authentication, included-usage permission and
native confirmation of no available credits. It does not start a thread/model turn or contact Holoboard. Account emails, native
stderr, raw exceptions and candidate text are not logged. Auth or quota checks may
contact Codex's native authentication/account services. Only native Codex reads
or refreshes its managed credentials.

The auth source defaults to `$CODEX_HOME`, then `~/.codex`.
`CURATOR_CODEX_AUTH_HOME` can select a separately logged-in native auth home.
The runner checks only file metadata and places a symlink to `auth.json` in its
private temporary home. It does not open, copy, export or store token contents.
Keyring-only auth fails with `codex_native_auth_file_required`. For that case,
create a separate private directory and use native Codex login there with
`CODEX_HOME` and `cli_auth_credentials_store="file"`, then point
`CURATOR_CODEX_AUTH_HOME` at it. The runner does not automate login or change
your normal Codex configuration.

## Run locally

Start with the backend in `dry_run`. Keep seven days of proposals for human
review before explicit administrator activation of the 30-day pilot. Starting the
runner does not activate the fund. The authenticated backend's curator status and
recent proposals support this review. No wallet credentials belong in this package.

### Human approval

Review is on by default and is independent of `dry_run`, `active` and `disabled`.
In an active fund, new selections enter a private queue with their original post,
editorial reason and proposed reward. Approval admits the post for seven days and
queues that exact reward. Rejection keeps it out of the board and reward queue.
Approvals recheck current eligibility, expiry and budgets. Stale proposal IDs or
changed amounts are rejected; repeated identical decisions are safe to retry.

Configure a separate backend `CURATOR_REVIEW_TOKEN` of at least 32 characters,
different from both `CURATOR_TOKEN` and `ADMIN_TOKEN`. For a local operator panel,
load the [reviewer environment](examples/reviewer.env.example) from a private file:

```sh
cd curator
npm run review
```

Open <http://127.0.0.1:4790>. The panel listens on loopback only and keeps the
reviewer bearer server-side. It uses origin, Host and per-process CSRF checks for
actions. Read the complete original and linked media before approving. The panel
does not connect a wallet or launch a model. Other users or processes with access
to the same machine remain within the operator's trust boundary.

Turning review off requires an explicit confirmation in the panel and applies
to future selections. Existing queued proposals still need approval or rejection.
Turning it on blocks new, unapproved reward sends, including previously admitted
automatic placements whose payments have not started. Existing placements remain
visible; their review concerns the reward only. Already started or uncertain
payments remain lookup-only during recovery. Approval of a dry-run proposal only
records the review and never turns it into a real placement or payment, including
after later activation.

`CURATOR_REVIEW_REQUIRED` sets the initial backend value, defaulting to `true`.
The reviewer setting is persisted and survives restart. The agent token cannot
approve, reject, change review settings or activate the fund. Review mode does
not replace the seven-day dry-run requirement or administrator activation.

Set the following in a private operator environment, using
[the example](examples/runner.env.example) as a template:

```sh
export CURATOR_BACKEND_URL='http://127.0.0.1:3334'
export CURATOR_STATE_PATH='/absolute/path/to/holoboard/curator/.state/state.json'
# Set CURATOR_TOKEN securely in the operator environment; do not put it in command history.
# Declare CURATOR_CHATGPT_OVERAGE_DISABLED=true only after verifying the prerequisites below.
npm start -- --once
npm start -- --watch
```

The URL must be an explicit origin with no userinfo, query or path. Plain HTTP is
allowed only for literal loopback hosts or `localhost`; remote origins require
HTTPS. Redirects are refused. The backend token is used only by the HTTP client
and is never inherited by Codex. Changing the backend for an existing state file
fails closed. Keep one stable state path for every process serving this backend;
do not rotate, delete or restore it to obtain more model rounds.

Optional settings:

| Variable | Purpose |
| --- | --- |
| `CURATOR_CODEX_BIN` | Native executable, preferably an absolute path. Defaults to `codex` on PATH. |
| `CURATOR_CODEX_AUTH_HOME` | Native auth source, without reading its config/plugins/session files. |
| `CURATOR_CODEX_MODEL` | Explicit model slug present in this binary's bundled catalog. |
| `CURATOR_CHATGPT_OVERAGE_DISABLED` | Must be exactly `true` for `--once`/`--watch`, after the billing prerequisites below are verified. Defaults to false in the example. |

Without an explicit model, isolated Codex uses its native default. Your normal
Codex model/profile/configuration is intentionally not imported. The native catalog's
model names, priorities, context sizes and other model parameters are preserved;
only tool capabilities are removed. This uses the same subscription and quotas as
the source login. API-key auth, another provider, unknown included-usage permission
and exhausted quotas stop the run. The runner never requests quota resets or a
paid API/provider fallback. `--watch` checks every five minutes, while awake.

### Subscription billing prerequisites

Native ChatGPT usage can consume existing paid credits after included limits are
exhausted. [OpenAI explains the included-usage and credit order](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-personal-plans). The native App Server protocol has no per-turn, server-enforced
included-only billing mode. Turning auto-reload off alone does not prevent use of
credits already on the account; there is no documented universal switch that
makes those existing credits unavailable to Codex.

Before `--once` or `--watch`, the operator must verify auto-reload and any applicable
workspace pay-as-you-go/overage billing are disabled, then explicitly set
`CURATOR_CHATGPT_OVERAGE_DISABLED=true`. This declaration is an operational
prerequisite, not a billing control sent to the provider. The runner does not
change the account or verify its external billing settings.

Every evaluation also requires a native credit snapshot confirming
`hasCredits=false` and `unlimited=false`. If a balance is supplied it must be an
exact zero decimal string. Missing/null credit snapshots, funded or unlimited
credits, and inconsistent metadata block inference. A snapshot with explicit
false flags and no available balance is accepted. Accounts with available paid
credits cannot use this strict runner. Explicit unsafe credit updates abort an
active turn; sparse missing/null updates preserve the last known preflight state.

`--check` remains metadata-only: it validates the absence of available credits
without requiring the declaration or starting a model turn. Its success status
explicitly marks external billing settings as unverified; it cannot verify
auto-reload or applicable overage settings. Included-usage permission and the native
credit snapshot are preflight evidence. Account funding/settings can
change between the read and a turn, and this client cannot control that race
atomically or guarantee zero additional charges. [Codex usage-limit guidance](https://developers.openai.com/codex/pricing/#what-happens-when-you-hit-usage-limits)
also describes ongoing usage after limits. Keep the account prerequisites
in force while the scheduler runs.

## Scheduling and recovery

There is at most one attempted evaluation in each UTC 12-hour slot, hence at most
two per UTC day. A durable UUID and occupied slot are saved before inference.
Failure, interruption, invalid output and restart consume that slot. Sleep never
creates a backlog: waking evaluates only the current slot. There is no wake lock,
remote worker or automatic catch-up. `SIGINT`/`SIGTERM` abort the child and preserve
the occupied slot.

Up to 50 candidates arrive in a backend batch. The HTTP body is bounded at 8 MB.
The backend visits distinct authors before taking additional notes from any one
author, using a per-batch seeded hash rather than raw event-ID ordering. The
runner preserves this author diversity while fitting whole events into a
180,000-byte aggregate editorial prompt. It skips entries that do not fit, records
reviewed/omitted counts in the prompt, and never truncates a post. Source relay
addresses are reduced to a deduplicated observed count; configured relay URL hosts, paths and query credentials are not
model input. Original signed note content and tags remain intact. Omitted candidates
remain in the backend pool for a later batch. A single 64 KiB event fits. If no event
fits, no model request starts. The model returns one decision for every reviewed
ID, with English reasons and unchanged multilingual source posts. A partial public
sample and low reactions do not prove quality or comprehensive relay coverage.

Structured output is validated and saved before POST. If a response is lost,
`--once`/`--watch` resubmit exactly the same UUID and payload before any new inference.
An ambiguous error, including 409, 401, 500 or network failure, retains the pending
payload and blocks new model usage. The backend's explicit HTTP 410 means an expired
batch was never admitted: the runner durably marks that submission failed and clears
only its pending payload, without another evaluation in the same invocation. An
already accepted UUID must replay its durable receipt even after expiry or disabling
the fund. Slot history is retained. Do not manually clear uncertain submissions.

State is atomically replaced with mode 0600 in a mode 0700 directory, synced before
submission, limited to 28 slot records plus one pending payload, and bound to the
backend origin. A directory lock prevents simultaneous processes from evaluating
the same state. A crash or forced kill can leave `state.json.lock`. Recovery fails
closed: stop the service, inspect `owner.json` in that lock, verify the recorded
process is no longer alive, and remove only the lock directory. Preserve
`state.json`, including pending decisions and the slot high-water mark. PID reuse
or uncertainty warrants manual inspection, not automatic lock removal.

For optional macOS launchd use the [wrapper](examples/runner.sh.example) and
[LaunchAgent template](examples/space.holoboard.curator.plist.example). Replace
absolute paths, keep the operator environment and logs in a private directory, and
review the files before installing or loading them. Nothing installs a service,
changes login items or wakes the machine automatically.

## Isolation and verification

Every evaluation starts a dedicated native stdio child with an empty working
directory, private temporary HOME/CODEX_HOME and a fresh ephemeral thread. The
child environment is an allowlist; API keys, backend/admin tokens, wallet/cloud
credentials, proxy settings, Node injection options and plugin environment variables
are not inherited. No repository, user instruction, plugin, MCP or session files are
copied. Managed configuration overrides that would weaken the restricted settings
are rejected.

The runner reads the binary's public `debug models --bundled` metadata, removes
patch/shell/clock/agent/tool capabilities, pins direct tool mode and disables tool,
plugin, hook, cloud skill, browser, MCP, code mode and agent features. JSON-RPC is
bounded and timed. All server requests are refused; unexpected tool items abort
the turn. Only a successfully completed turn with one final structured response
can be submitted. A single unphased complete message is supported for native
providers that omit `phase`. Repository/file access and wallet choices are outside
the model's interface. Native sandboxing is additional protection; the tool-free
surface is established by configuration/catalog and the audit below.

Ordinary tests use fake process transports and loopback backend servers. They do
not use a real model, real login, real wallet or external publication. To audit the
installed binary against a loopback fake Responses provider, with no credentials
or external inference, run:

```sh
CURATOR_NATIVE_CODEX_TEST=1 node --experimental-strip-types --test test/native.test.ts
```

The native audit is explicitly skipped in ordinary `npm test`. It captures the
actual outbound Responses and ResponsesLite tool inventories, including structured
`additional_tools` and `tool_search_output` input items, with a positive control; it is not a live subscription inference
test. Real model availability, editorial quality and end-to-end public delivery
require a separately authorized controlled check and the dry-run review period.
Hard process termination can leave a private temporary directory, which may contain
public prompt material and a symlink, never a copied auth file. Remove stale
temporary directories only after confirming their child processes have stopped.

The implementation follows [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server),
the installed CLI's exported 0.163.0 protocol schemas and the official
[configuration reference](https://developers.openai.com/codex/config-reference/).
