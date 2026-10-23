import { getPublicKey } from 'nostr-tools/pure';
import { decode } from 'nostr-tools/nip19';
import { AccountClientError, createWebTransport, utf8Bytes, withClientDeadline } from './transport.ts';
import type { AccountTransport, ErrorCode } from './transport.ts';
import { AccountSigner } from './signer.ts';
import { scopeForTransport } from './auth-coordination.ts';
import type { AccountAuthScope } from './auth-coordination.ts';
export { createAccountAuthScope } from './auth-coordination.ts';
export type { AccountAuthScope } from './auth-coordination.ts';
let defaultWebTransport: AccountTransport | undefined;
export { AccountClientError, createWebTransport } from './transport.ts';
export type { AccountTransport, TransportRequest, TransportResponse, FetchLike, ErrorCode } from './transport.ts';
export { AccountSigner, validateSignedEvent } from './signer.ts';
export interface AccountUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
}
export interface AccountSession {
  user: AccountUser;
  session: {
    id: string;
    expiresAt: string;
  };
}
export interface AccountIdentity {
  accountId: string;
  publicKey: string;
  capabilities: {
    allowedKinds: number[];
    exportEnabled: boolean;
  };
}
export interface ClientConfiguration {
  baseURL: string;
  authBasePath?: string;
  transport?: AccountTransport;
  /** Share explicitly when separate transport functions use the same cookie jar. */
  authScope?: AccountAuthScope;
  timeoutMs?: number;
  now?: () => number;
}
interface AuthSnapshot {
  epoch: number;
  scopeRevision: number;
  accountId: string;
  expiresAt: number;
}
const codes: ErrorCode[] = ['INVALID_INPUT', 'UNAUTHENTICATED', 'EMAIL_UNVERIFIED', 'PERMISSION_DENIED', 'IDENTITY_UNAVAILABLE', 'TEMPORARILY_UNAVAILABLE', 'REQUEST_TOO_LARGE', 'REQUEST_TIMEOUT', 'RATE_LIMITED', 'NOT_FOUND', 'UNSUPPORTED_MEDIA_TYPE', 'REQUEST_HEADERS_TOO_LARGE'];
function invalid(): never {
  throw new AccountClientError('INVALID_RESPONSE');
}
function parseUser(value: unknown): AccountUser {
  const u = value as AccountUser;
  if (!u || typeof u.id !== 'string' || !u.id || typeof u.email !== 'string' || typeof u.emailVerified !== 'boolean' || typeof u.name !== 'string')
    return invalid();
  return { id: u.id, email: u.email, emailVerified: u.emailVerified, name: u.name };
}
export class AccountClient {
  readonly signer: AccountSigner;
  private readonly config: ClientConfiguration;
  private readonly transport: AccountTransport;
  private readonly authScope: AccountAuthScope;
  private epoch = 0;
  private state: AccountSession | null = null;
  constructor(config: ClientConfiguration) {
    if (!/^https:\/\/[^/?#@\s]+$/.test(config.baseURL) || !/^\/[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9-]+)*$/.test(config.authBasePath ?? '/v1/auth') || !Number.isInteger(config.timeoutMs ?? 15000) || (config.timeoutMs ?? 15000) < 1 || (config.timeoutMs ?? 15000) > 60000)
      throw new AccountClientError('INVALID_INPUT');
    this.config = { ...config };
    this.transport = config.transport ?? (defaultWebTransport ??= createWebTransport());
    this.authScope = config.authScope ?? scopeForTransport(this.transport, config.baseURL);
    this.signer = new AccountSigner(this);
  }
  get currentSession(): AccountSession | null {
    return this.state ? { user: { ...this.state.user }, session: { ...this.state.session } } : null;
  }
  private clear() {
    this.epoch++;
    this.state = null;
  }
  captureAuth(): AuthSnapshot {
    if (!this.state || Date.parse(this.state.session.expiresAt) <= (this.config.now ?? Date.now)()) {
      this.clear();
      throw new AccountClientError('UNAUTHENTICATED', 401);
    }
    this.authScope.assertReady();
    return { epoch: this.epoch, scopeRevision: this.authScope.revision, accountId: this.state.user.id, expiresAt: Date.parse(this.state.session.expiresAt) };
  }
  assertAuth(snapshot: AuthSnapshot) {
    if (this.epoch !== snapshot.epoch || this.authScope.revision !== snapshot.scopeRevision || this.state?.user.id !== snapshot.accountId || snapshot.expiresAt <= (this.config.now ?? Date.now)()) {
      if (this.epoch === snapshot.epoch)
        this.clear();
      throw new AccountClientError('STALE_AUTH_STATE');
    }
    this.authScope.assertReady();
  }
  /** Internal wire operation is public for composed adapters; it never accepts account authority. */
  async request(path: string, body?: unknown): Promise<unknown> {
    if (!path.startsWith('/') || path.startsWith('//'))
      throw new AccountClientError('INVALID_INPUT');
    let serialized: string | undefined;
    try {
      serialized = body === undefined ? undefined : JSON.stringify(body);
    }
    catch {
      throw new AccountClientError('INVALID_INPUT');
    }
    if (serialized !== undefined && utf8Bytes(serialized) > 65536)
      throw new AccountClientError('REQUEST_TOO_LARGE', 413);
    const start = this.epoch;
    try {
      const prefix = this.config.authBasePath ?? '/v1/auth';
      // Native authentication responses can change cookies even on GET or errors.
      // Serialize the namespace as a whole, independently of auth intent revisions.
      const authRequest = path.startsWith(prefix + '/');
      const operation = { url: this.config.baseURL + path, method: body === undefined ? 'GET' as const : 'POST' as const, ...(serialized === undefined ? {} : { body: serialized }), timeoutMs: this.config.timeoutMs ?? 15000, maxResponseBytes: 131072 };
      const response = authRequest ? await this.authScope.send(this.transport, operation) : await withClientDeadline(() => this.transport(operation), operation.timeoutMs);
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599 || typeof response.body !== 'string' || utf8Bytes(response.body) > 131072)
        return invalid();
      let value: unknown;
      try {
        value = JSON.parse(response.body);
      }
      catch {
        return invalid();
      }
      if (response.status < 200 || response.status >= 300) {
        if (response.status === 401 && this.epoch === start)
          this.clear();
        const code = (value as {
          error?: {
            code?: unknown;
          };
        })?.error?.code;
        const safe = codes.includes(code as ErrorCode) ? code as ErrorCode : response.status === 429 ? 'RATE_LIMITED' : response.status === 401 ? 'UNAUTHENTICATED' : response.status >= 500 ? 'TEMPORARILY_UNAVAILABLE' : 'INVALID_RESPONSE';
        const retry = response.retryAfter && /^\d{1,6}$/.test(response.retryAfter) ? Number(response.retryAfter) : undefined;
        throw new AccountClientError(safe, response.status, retry);
      }
      return value;
    }
    catch (error) {
      throw error instanceof AccountClientError ? error : new AccountClientError('NETWORK_ERROR');
    }
  }
  private auth(path: string, body?: unknown) {
    return this.request((this.config.authBasePath ?? '/v1/auth') + path, body);
  }
  async register(fields: {
    email: string;
    password: string;
    name: string;
    callbackURL?: string;
  }) {
    await this.auth('/sign-up/email', fields);
    return { accepted: true as const };
  }
  async verifyEmail(token: string): Promise<{ verified: true }> {
    // Native callback redirects conceal both success and errors from browser fetch.
    // Programmatic verification requires the native explicit JSON result instead.
    const result = await this.auth('/verify-email?token=' + encodeURIComponent(token)) as { status?: unknown };
    if (result?.status !== true) return invalid();
    return { verified: true };
  }
  async requestVerification(email: string, callbackURL?: string) {
    await this.auth('/send-verification-email', { email, ...(callbackURL ? { callbackURL } : {}) });
    return { accepted: true as const };
  }
  async login(email: string, password: string) {
    this.clear();
    const generation = this.authScope.begin();
    const epoch = this.epoch;
    const result = await this.auth('/sign-in/email', { email, password }) as {
      user?: unknown;
    };
    if (epoch !== this.epoch || generation !== this.authScope.revision)
      throw new AccountClientError('STALE_AUTH_STATE');
    const user = parseUser(result.user);
    const loaded = await this.loadSession(epoch, user.id, generation);
    if (loaded.epoch !== this.epoch || generation !== this.authScope.revision || loaded.session === null)
      throw new AccountClientError('STALE_AUTH_STATE');
    this.authScope.complete(generation);
    return loaded.session;
  }
  async getSession(): Promise<AccountSession | null> {
    const epoch = this.epoch, scopeRevision = this.authScope.revision;
    this.authScope.assertRestorable();
    const loaded = await this.loadSession(epoch, undefined, scopeRevision, true);
    this.authScope.assertRestorable();
    if (loaded.epoch !== this.epoch || scopeRevision !== this.authScope.revision)
      throw new AccountClientError('STALE_AUTH_STATE');
    return loaded.session;
  }
  private async loadSession(epoch: number, expectedAccountId?: string, scopeRevision = this.authScope.revision, restoring = false): Promise<{ session: AccountSession | null; epoch: number }> {
    if (scopeRevision !== this.authScope.revision) throw new AccountClientError('STALE_AUTH_STATE');
    const result = await this.auth('/get-session') as AccountSession | null;
    if (restoring) this.authScope.assertRestorable();
    if (epoch !== this.epoch || scopeRevision !== this.authScope.revision)
      throw new AccountClientError('STALE_AUTH_STATE');
    if (result === null) {
      this.clear();
      return { session: null, epoch: this.epoch };
    }
    const user = parseUser(result.user);
    if (expectedAccountId !== undefined && user.id !== expectedAccountId) {
      this.clear();
      throw new AccountClientError('STALE_AUTH_STATE');
    }
    if (!result.session || typeof result.session.id !== 'string' || !Number.isFinite(Date.parse(result.session.expiresAt)))
      return invalid();
    if (Date.parse(result.session.expiresAt) <= (this.config.now ?? Date.now)()) {
      this.clear();
      return { session: null, epoch: this.epoch };
    }
    if (!this.state || this.state.user.id !== user.id || this.state.session.id !== result.session.id)
      this.epoch++;
    this.state = { user, session: { id: result.session.id, expiresAt: result.session.expiresAt } };
    return { session: this.currentSession, epoch: this.epoch };
  }
  async logout() {
    this.clear();
    const generation = this.authScope.begin();
    await this.auth('/sign-out', {});
    this.authScope.complete(generation);
  }
  async requestRecovery(email: string, redirectTo?: string) {
    await this.auth('/request-password-reset', { email, ...(redirectTo ? { redirectTo } : {}) });
    return { accepted: true as const };
  }
  async resetPassword(token: string, newPassword: string) {
    this.clear();
    const generation = this.authScope.begin();
    await this.auth('/reset-password', { token, newPassword });
    this.authScope.complete(generation);
  }
  async getIdentity(): Promise<AccountIdentity> {
    const state = this.captureAuth();
    const value = await this.request('/v1/identity') as AccountIdentity;
    this.assertAuth(state);
    if (value?.accountId !== state.accountId) {
      this.clear();
      throw new AccountClientError('STALE_AUTH_STATE');
    }
    if (!/^[a-f0-9]{64}$/.test(value.publicKey) || !value.capabilities || !Array.isArray(value.capabilities.allowedKinds) || value.capabilities.allowedKinds.some(k => !Number.isSafeInteger(k)) || typeof value.capabilities.exportEnabled !== 'boolean')
      return invalid();
    return { accountId: value.accountId, publicKey: value.publicKey, capabilities: { allowedKinds: [...value.capabilities.allowedKinds], exportEnabled: value.capabilities.exportEnabled } };
  }
  async exportKey(password: string): Promise<{
    publicKey: string;
    nsec: string;
  }> {
    const state = this.captureAuth();
    const identity = await this.getIdentity();
    this.assertAuth(state);
    const value = await this.request('/v1/identity/export', { password }) as {
      publicKey: string;
      nsec: string;
    };
    this.assertAuth(state);
    if (value?.publicKey !== identity.publicKey || typeof value.nsec !== 'string' || value.nsec.length > 128) return invalid();
    let bytes: Uint8Array | undefined;
    try {
      const decoded = decode(value.nsec);
      if (decoded.type !== 'nsec') return invalid();
      bytes = decoded.data;
      if (bytes.length !== 32 || getPublicKey(bytes) !== identity.publicKey) return invalid();
      return { publicKey: value.publicKey, nsec: value.nsec };
    } catch { return invalid(); } finally { bytes?.fill(0); }
  }
}
export function createAccountClient(config: ClientConfiguration) {
  return new AccountClient(config);
}
