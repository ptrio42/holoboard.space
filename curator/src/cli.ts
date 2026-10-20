import { Backend } from './backend.ts';
import { Codex, defaultAuthHome } from './codex.ts';
import { StateStore } from './state.ts';
import { runOnce, watch } from './runner.ts';
import { SafeError } from './contract.ts';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const help = `Holoboard local discovery curator (Node 24+)
Usage: npm start -- --check | --once | --watch

--check  Validate managed auth, included quotas, no available credits and tool-free catalog.
         No model turn or backend request. Billing settings still require operator verification.
--once   Evaluate the current UTC 12-hour slot, or retry a saved submission.
--watch  Check every five minutes while this process and machine are awake.

For --once/--watch set CURATOR_BACKEND_URL, CURATOR_TOKEN and CURATOR_STATE_PATH.
Set CURATOR_CHATGPT_OVERAGE_DISABLED=true only after verifying account billing.
Evaluation requires native confirmation of no available paid credits.
Optional: CURATOR_CODEX_BIN, CURATOR_CODEX_AUTH_HOME, CURATOR_CODEX_MODEL.
No API-key fallback, automatic login, publication activation or wallet access.
`;
export async function main(args = process.argv.slice(2), env = process.env): Promise<void> {
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]!))) { process.stdout.write(help); return; }
  if (args.length !== 1 || !['--check', '--once', '--watch'].includes(args[0]!)) throw new SafeError('invalid_arguments');
  const abort = new AbortController();
  const stop = (): void => { abort.abort(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const editor = new Codex({ executable: env.CURATOR_CODEX_BIN ?? 'codex', authHome: defaultAuthHome(env), signal: abort.signal, overageDisabled: env.CURATOR_CHATGPT_OVERAGE_DISABLED === 'true', ...(env.CURATOR_CODEX_MODEL ? { model: env.CURATOR_CODEX_MODEL } : {}) });
  const log = (status: string): void => { process.stdout.write(JSON.stringify({ at: new Date().toISOString(), status }) + '\n'); };
  try {
    if (args[0] === '--check') { await editor.check(); log('managed_chatgpt_auth_quota_and_no_available_credits_verified_billing_settings_unverified'); return; }
    if (env.CURATOR_CHATGPT_OVERAGE_DISABLED !== 'true') throw new SafeError('chatgpt_overage_disabled_declaration_required');
    if (!env.CURATOR_BACKEND_URL || !env.CURATOR_TOKEN || !env.CURATOR_STATE_PATH) throw new SafeError('explicit_backend_token_and_state_path_required');
    const backend = new Backend(env.CURATOR_BACKEND_URL, env.CURATOR_TOKEN);
    const store = new StateStore(env.CURATOR_STATE_PATH, backend.origin);
    const run = (): Promise<import('./runner.ts').RunStatus> => runOnce(store, backend, editor);
    if (args[0] === '--once') { log(await run()); return; }
    await watch(run, log, abort.signal);
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    // Raw exceptions, URLs, bearer credentials, account details and candidate content are never printed.
    process.stderr.write(JSON.stringify({ status: e instanceof SafeError ? e.message : 'runner_failed' }) + '\n');
    process.exitCode = 1;
  });
}
