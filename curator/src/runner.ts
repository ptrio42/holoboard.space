import { StateStore, slotAt } from './state.ts';
import { fitBatch } from './prompt.ts';
import { parseDecisions, SafeError } from './contract.ts';
import type { Batch, Decision, Payload } from './contract.ts';
export interface BackendClient { candidates(): Promise<Batch>; submit(payload: Payload): Promise<void> }
export interface Editor { evaluate(batch: Batch): Promise<Decision[]>; check(): Promise<void> }
export type RunStatus = 'submitted' | 'retried_submission' | 'already_attempted' | 'disabled' | 'empty' | 'completed' | 'slot_changed' | 'expired_submission';
export async function runOnce(store: StateStore, backend: BackendClient, editor: Editor, now: () => number = Date.now): Promise<RunStatus> {
  return store.lock(async () => {
    const state = await store.load();
    if (state.pending) {
      // Any uncertain receipt blocks another inference. Retries use identical serialized values and UUID.
      const previous = state.attempts.find(a => a.run_id === state.pending!.run_id);
      try { await backend.submit(state.pending); }
      catch (e) {
        // This authenticated backend returns 410 only when no durable admission exists.
        if (!(e instanceof SafeError) || e.message !== 'backend_http_410') throw e;
        if (previous) previous.status = 'failed';
        delete state.pending; await store.save(state); return 'expired_submission';
      }
      if (previous) previous.status = 'submitted';
      delete state.pending; await store.save(state); return 'retried_submission';
    }
    if (slotAt(now()) <= state.high_water_slot) return 'already_attempted';
    const currentSlot = slotAt(now());
    const fetched = await backend.candidates();
    if (slotAt(now()) !== currentSlot) return 'slot_changed';
    const batch = fetched;
    if (batch.mode === 'disabled') return 'disabled';
    if (batch.completed) return 'completed';
    if (!batch.candidates.length) return 'empty';
    const reviewBatch = fitBatch(batch);
    const attempt = store.start(state, now());
    if (!attempt) return 'already_attempted';
    await store.save(state); // Failure, timeout and restart consume this UTC 12-hour slot.
    let decisions: Decision[];
    try {
      decisions = parseDecisions({ decisions: await editor.evaluate(reviewBatch) }, reviewBatch.candidates.map(c => c.event.id), reviewBatch);
    } catch (e) {
      attempt.status = 'failed'; await store.save(state);
      throw e instanceof SafeError ? e : new SafeError('editor_failed');
    }
    const payload: Payload = { run_id: attempt.run_id, batch_id: batch.batch_id, decisions };
    if (Buffer.byteLength(JSON.stringify(payload)) > 65536) { attempt.status = 'failed'; await store.save(state); throw new SafeError('decisions_payload_too_large'); }
    state.pending = payload;
    await store.save(state); // Durable structured output must exist before the first POST.
    try { await backend.submit(state.pending); }
    catch (e) {
      if (!(e instanceof SafeError) || e.message !== 'backend_http_410') throw e;
      attempt.status = 'failed'; delete state.pending; await store.save(state); return 'expired_submission';
    }
    attempt.status = 'submitted'; delete state.pending; await store.save(state);
    return 'submitted';
  });
}

export async function watch(run: () => Promise<RunStatus>, report: (status: string) => void, signal: AbortSignal, intervalMs = 300_000): Promise<void> {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000) throw new SafeError('watch_interval_too_short');
  while (!signal.aborted) {
    try { report(await run()); } catch (e) { report(e instanceof SafeError ? e.message : 'runner_failed'); }
    if (signal.aborted) break;
    // One fresh current-slot check after waking. There is no backlog or catch-up loop.
    await new Promise<void>(resolve => {
      const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, intervalMs);
      signal.addEventListener('abort', done, { once: true });
    });
  }
}
