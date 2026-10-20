import { StateStore } from '../src/state.ts';
import { SafeError } from '../src/contract.ts';
const store = new StateStore(process.argv[2]!, 'http://127.0.0.1:3334');
try { await store.lock(async () => {}); process.exitCode = 0; }
catch (e) { process.stdout.write(e instanceof SafeError ? e.message : 'unexpected'); process.exitCode = 2; }
