import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.ts';

for (const mode of ['--once', '--watch']) for (const declaration of [undefined, 'false', 'TRUE', '1']) test(mode + ' requires the explicit billing declaration before backend or native access: ' + String(declaration), async () => {
  const env: NodeJS.ProcessEnv = {
    CURATOR_BACKEND_URL: 'http://127.0.0.1:1', CURATOR_TOKEN: 'local-test-only', CURATOR_STATE_PATH: '/unused-state-path',
    CURATOR_CODEX_AUTH_HOME: '/nonexistent-auth-home-for-this-test',
    ...(declaration === undefined ? {} : { CURATOR_CHATGPT_OVERAGE_DISABLED: declaration }),
  };
  await assert.rejects(main([mode], env), /chatgpt_overage_disabled_declaration_required/);
});
