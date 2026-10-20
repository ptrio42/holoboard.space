import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { SafeError, object } from './contract.ts';

export interface RpcMessage { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown }
export interface ProcessTransport {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: 'error' | 'exit' | 'close', listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}
export type SpawnedTransport = ChildProcessWithoutNullStreams | ProcessTransport;
interface Pending { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }

export class Rpc extends EventEmitter {
  #transport: SpawnedTransport;
  #pending = new Map<number, Pending>();
  #next = 1;
  #buffer = '';
  #bytes = 0;
  #failed: SafeError | undefined;
  #closed = false;
  constructor(transport: SpawnedTransport) {
    super(); this.#transport = transport;
    transport.stdout.setEncoding('utf8');
    transport.stdout.on('data', (chunk: string) => this.#read(chunk));
    // Never print subprocess stderr. It may contain credentials, emails or untrusted content.
    transport.stderr.on('data', () => {});
    transport.on('error', () => this.#fail('codex_process_error'));
    transport.on('exit', () => { if (!this.#closed) this.#fail('codex_process_exited'); });
    transport.stdin.on('error', () => this.#fail('codex_stdin_error'));
  }
  #read(chunk: string): void {
    if (this.#closed || this.#failed) return;
    this.#bytes += Buffer.byteLength(chunk);
    if (this.#bytes > 8_000_000) { this.#fail('codex_output_too_large'); return; }
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer) > 1_000_000) { this.#fail('codex_line_too_large'); return; }
    let newline: number;
    while ((newline = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, newline); this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let m: unknown;
      try { m = JSON.parse(line); } catch { this.#fail('codex_invalid_json'); return; }
      if (!object(m)) { this.#fail('codex_invalid_message'); return; }
      if (typeof m.method === 'string') {
        if (m.id !== undefined) {
          try { this.#send({ id: m.id as string | number, error: { code: -32601, message: 'Runner denies all server requests' } }); } catch { /* The request is denied even when its response pipe has closed. */ }
          this.#fail('codex_server_request_denied'); return;
        }
        this.emit('notification', m);
      } else if (typeof m.id === 'number' && this.#pending.has(m.id)) {
        const p = this.#pending.get(m.id)!; this.#pending.delete(m.id); clearTimeout(p.timer);
        if (m.error !== undefined) p.reject(new SafeError('codex_rpc_rejected'));
        else if (Object.hasOwn(m, 'result')) p.resolve(m.result);
        else { p.reject(new SafeError('codex_invalid_response')); this.#fail('codex_invalid_response'); }
      } else { this.#fail('codex_unexpected_response'); return; }
      if (this.#failed) return;
    }
  }
  #send(m: RpcMessage): void {
    if (this.#failed) throw this.#failed;
    this.#transport.stdin.write(JSON.stringify(m) + '\n');
  }
  notify(method: string, params?: unknown): void { this.#send({ method, ...(params === undefined ? {} : { params }) }); }
  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.#failed) return Promise.reject(this.#failed);
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new SafeError('codex_rpc_timeout')); this.#fail('codex_rpc_timeout'); }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.#send({ id, method, params }); } catch { clearTimeout(timer); this.#pending.delete(id); reject(new SafeError('codex_write_failed')); }
    });
  }
  abort(code: string): void { this.#fail(code); }
  #fail(code: string): void {
    if (this.#failed || this.#closed) return;
    this.#failed = new SafeError(code);
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(this.#failed); }
    this.#pending.clear(); this.emit('failure', this.#failed); this.#transport.kill('SIGTERM');
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(new SafeError('codex_closed')); }
    this.#pending.clear(); this.#transport.stdin.end(); this.#transport.kill('SIGTERM');
    // Bounded shutdown also handles an unresponsive app-server.
    await new Promise(resolve => setTimeout(resolve, 100));
    this.#transport.kill('SIGKILL'); this.emit('closed');
  }
}
