import { AccountClientError, withClientDeadline } from './transport.ts';
import type { AccountTransport, TransportRequest, TransportResponse } from './transport.ts';

/** Share one scope for SDK instances backed by the same cookie jar and API. */
export class AccountAuthScope {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private generation = 0;
  private recoveryRequired = false;
  begin(): number { return ++this.generation; }
  complete(generation: number): void { if (generation === this.generation) this.recoveryRequired = false; }
  assertReady(): void {
    if (this.recoveryRequired || this.pending) throw new AccountClientError('TEMPORARILY_UNAVAILABLE', 503);
  }
  get revision(): number { return this.generation; }
  get hasPending(): boolean { return this.pending > 0; }
  async wait(milliseconds: number): Promise<void> {
    await withClientDeadline(() => this.tail, milliseconds);
  }
  async send(transport: AccountTransport, input: TransportRequest): Promise<TransportResponse> {
    if (this.pending >= 8) throw new AccountClientError('TEMPORARILY_UNAVAILABLE', 503);
    const previous = this.pending ? this.tail : undefined;
    this.pending++;
    let queued: TransportRequest | undefined = input;
    const work = (async () => {
      if (previous) await previous;
      if (!queued) throw new AccountClientError('REQUEST_TIMEOUT');
      const request = queued; queued = undefined;
      // Keep the fence until the actual transport settles, even after an SDK timeout.
      return transport(request);
    })();
    this.tail = work.then(() => { this.pending--; }, () => { this.pending--; });
    try { return await withClientDeadline(() => work, input.timeoutMs, () => { queued = undefined; this.recoveryRequired = true; }); }
    catch (error) { this.recoveryRequired = true; throw error; }
  }
}
export function createAccountAuthScope(): AccountAuthScope { return new AccountAuthScope(); }
const scopes = new WeakMap<AccountTransport, Map<string, AccountAuthScope>>();
export function scopeForTransport(transport: AccountTransport, origin: string): AccountAuthScope {
  let origins = scopes.get(transport);
  if (!origins) { origins = new Map(); scopes.set(transport, origins); }
  let scope = origins.get(origin);
  if (!scope) { scope = createAccountAuthScope(); origins.set(origin, scope); }
  return scope;
}
