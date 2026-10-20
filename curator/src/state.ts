import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, rename, rm, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SafeError, object, exact, validatePayload } from './contract.ts';
import type { Payload } from './contract.ts';
export const SLOT_MS = 12 * 60 * 60 * 1000;
export const slotAt = (now: number): number => Math.floor(now / SLOT_MS);
export interface Attempt { slot: number; run_id: string; status: 'started' | 'failed' | 'submitted' }
export interface State {
  version: 1; backend: string; high_water_slot: number; attempts: Attempt[]; pending?: Payload;
}
export class StateStore {
  path: string;
  backend: string;
  constructor(path: string, backend: string) { this.path = resolve(path); this.backend = backend; }
  async lock<T>(fn: () => Promise<T>): Promise<T> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const st = await lstat(dir);
    if (st.isSymbolicLink() || (st.mode & 0o077) !== 0) throw new SafeError('state_directory_must_be_private');
    const lock = this.path + '.lock';
    try { await mkdir(lock, { mode: 0o700 }); } catch { throw new SafeError('runner_locked'); }
    try {
      const f = await open(lock + '/owner.json', 'wx', 0o600);
      try { await f.writeFile(JSON.stringify({ pid: process.pid })); await f.sync(); } finally { await f.close(); }
      return await fn();
    } finally { await rm(lock, { recursive: true, force: true }); }
  }
  async load(): Promise<State> {
    let data: string;
    try {
      const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const st = await file.stat();
        if (!st.isFile() || st.size > 500_000 || (st.mode & 0o077) !== 0) throw new SafeError('unsafe_state_file');
        data = await file.readFile('utf8');
      } finally { await file.close(); }
    } catch (e) {
      if (object(e) && e.code === 'ENOENT') return { version: 1, backend: this.backend, high_water_slot: -1, attempts: [] };
      throw new SafeError('state_read_failed');
    }
    let s: unknown;
    try { s = JSON.parse(data); } catch { throw new SafeError('state_invalid'); }
    if (!object(s) || s.version !== 1 || s.backend !== this.backend || !Number.isSafeInteger(s.high_water_slot) || !Array.isArray(s.attempts) || s.attempts.length > 28) throw new SafeError('state_invalid');
    if (!exact(s, ['version', 'backend', 'high_water_slot', 'attempts', ...(s.pending === undefined ? [] : ['pending'])])) throw new SafeError('state_invalid');
    const seen = new Set<number>();
    for (const a of s.attempts) {
      if (!object(a) || !exact(a, ['slot', 'run_id', 'status']) || !Number.isSafeInteger(a.slot) || Number(a.slot) < 0 || seen.has(Number(a.slot)) || Number(a.slot) > Number(s.high_water_slot) || typeof a.run_id !== 'string' || !/^[a-f0-9-]{36}$/.test(a.run_id) || !['started', 'failed', 'submitted'].includes(String(a.status))) throw new SafeError('state_invalid');
      seen.add(Number(a.slot));
    }
    if (s.pending !== undefined) validatePayload(s.pending);
    return s as unknown as State;
  }
  async save(state: State): Promise<void> {
    const temp = this.path + '.' + randomUUID() + '.tmp';
    const data = JSON.stringify(state);
    if (Buffer.byteLength(data) > 500_000) throw new SafeError('state_too_large');
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path);
      const dir = await open(dirname(this.path), constants.O_RDONLY);
      try { await dir.sync(); } finally { await dir.close(); }
    } catch { throw new SafeError('state_write_failed'); }
    finally { await rm(temp, { force: true }); }
  }
  start(state: State, now: number): Attempt | undefined {
    const slot = slotAt(now);
    // High-water mark prevents clock rollback, retained-history pruning and wakes from replaying older slots.
    if (slot <= state.high_water_slot) return undefined;
    const attempt: Attempt = { slot, run_id: randomUUID(), status: 'started' };
    state.high_water_slot = slot;
    state.attempts = [...state.attempts.filter(a => a.slot >= slot - 27), attempt].slice(-28);
    return attempt;
  }
}
