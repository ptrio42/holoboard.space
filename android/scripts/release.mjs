import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const android = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(android, '..');
const command = process.argv[2];
const unsigned = join(android, 'app-release-unsigned-aligned.apk');
const signed = join(android, 'app-release-signed.apk');
const verify = join(android, 'scripts/verify-release.py');
function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: android, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${binary} failed (${result.status ?? result.signal})`);
}
function tools() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error('Set ANDROID_HOME to the Android SDK');
  return join(sdk, 'build-tools/36.1.0');
}
const check = () => run('python3', ['-B', verify]);
try {
  if (command === 'build') {
    const sdkTools = tools();
    run(join(android, 'gradlew'), ['--no-daemon', '--max-workers=2', '-Dorg.gradle.jvmargs=-Xmx1024m', 'assembleRelease']);
    run(join(sdkTools, 'zipalign'), ['-f', '-P', '16', '4', join(android, 'app/build/outputs/apk/release/app-release-unsigned.apk'), unsigned]);
    run('python3', ['-B', verify, '--unsigned']);
  } else if (command === 'sign') {
    const candidate = join(android, 'app-release-candidate-signed.apk');
    const { signingKey } = JSON.parse(readFileSync(join(android, 'twa-manifest.json'), 'utf8'));
    run('python3', ['-B', verify, '--unsigned']);
    // apksigner prompts on the terminal; passwords never enter command arguments.
    run(join(tools(), 'apksigner'), ['sign', '--ks', resolve(android, signingKey.path), '--ks-key-alias', signingKey.alias, '--out', candidate, unsigned]);
    run('python3', ['-B', verify, '--apk', candidate]);
    renameSync(candidate, signed);
    if (existsSync(`${candidate}.idsig`)) renameSync(`${candidate}.idsig`, `${signed}.idsig`);
    else rmSync(`${signed}.idsig`, { force: true });
  } else if (command === 'check') {
    check();
  } else if (command === 'check-unsigned') {
    run('python3', ['-B', verify, '--unsigned']);
  } else if (command === 'zapstore-check' || command === 'zapstore-publish') {
    check();
    const publishing = command === 'zapstore-publish';
    run('zsp', publishing ? ['publish', 'zapstore.yaml'] : ['publish', '--check', 'zapstore.yaml'],
      { cwd: root, env: { ...process.env, SIGN_WITH: 'browser' } });
  } else {
    throw new Error('Use build, sign, check, check-unsigned, zapstore-check or zapstore-publish');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
