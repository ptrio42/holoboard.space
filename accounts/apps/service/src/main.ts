import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAccountServer, createNodeAccountListener, initializeAccountDatabase, initializeAccountCustody, initializeIdentityInventory } from '@holoboard/accounts-server';
import type { AccountMail, MailAdapter } from '@holoboard/accounts-server';
import { loadServiceConfiguration } from './config.ts';
import type { ServiceConfiguration } from './config.ts';
export { loadServiceConfiguration } from './config.ts';
export type { ServiceConfiguration } from './config.ts';
/** Explicit loopback development only. No public mailbox route or automatic token logging. */
export function createDevelopmentCapture(path: string): MailAdapter {
  return { async send(message: AccountMail, signal: AbortSignal) {
      signal.throwIfAborted();
      const payload = JSON.stringify(message) + '\n';
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      try {
        const info = await file.stat();
        if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() || info.size + Buffer.byteLength(payload) > 1024 * 1024)
          throw new Error('MAIL_CAPTURE_UNAVAILABLE');
        signal.throwIfAborted();
        await file.writeFile(payload);
        await file.sync();
      }
      finally {
        await file.close();
      }
    } };
}
export async function initializeService(config: ServiceConfiguration) {
  const custody = config.account.custody;
  if (!custody)
    throw new Error('INVALID_SERVICE_CONFIGURATION');
  initializeAccountDatabase(config.account.databasePath);
  initializeIdentityInventory(custody.inventoryPath, custody.installationId);
  initializeAccountCustody(config.account.databasePath, custody);
}
export async function startAccountService(config: ServiceConfiguration) {
  const app = createAccountServer({ ...config.account, ...(config.developmentCapturePath ? { mail: createDevelopmentCapture(config.developmentCapturePath) } : {}) });
  return serveAccountApplication(config, app, createNodeAccountListener({ handler: app.handler, baseURL: config.account.baseURL, tls: config.tls }));
}
/** Shared lifecycle; embedding supplies the same handler and Node bridge. */
export async function serveAccountApplication(config: ServiceConfiguration, app: ReturnType<typeof createAccountServer>, bridge: ReturnType<typeof createNodeAccountListener>) {
  try {
    await app.ready();
    await new Promise<void>((resolve, reject) => {
      bridge.listener.once('error', reject);
      bridge.listener.listen(config.port, config.listenHost, () => {
        bridge.listener.off('error', reject);
        resolve();
      });
    });
  }
  catch {
    app.close();
    throw new Error('ACCOUNT_STARTUP_FAILED');
  }
  let stopping = false;
  let work: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (stopping || work)
      return;
    work = app.mailOutbox?.drain().catch(() => {
    }).finally(() => {
      work = undefined;
    });
  }, config.mailIntervalMs);
  timer.unref();
  let stopped: Promise<void> | undefined;
  let listenerClosed = false;
  return { baseURL: config.account.baseURL, async stop() {
      stopped ??= (async () => {
        stopping = true;
        clearInterval(timer);
        const pending = Promise.all([listenerClosed ? Promise.resolve() : bridge.close(config.shutdownTimeoutMs).then(() => {
            listenerClosed = true;
          }), work]).then(() => app.whenIdle());
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([pending, new Promise<never>((_, reject) => {
              deadline = setTimeout(() => reject(new Error('ACCOUNT_SHUTDOWN_INCOMPLETE')), config.shutdownTimeoutMs);
            })]);
        }
        finally {
          clearTimeout(deadline);
        }
        app.close();
      })().catch((error: unknown) => {
        stopped = undefined;
        throw error;
      });
      return stopped;
    } };
}
export async function runServiceCLI(args = process.argv.slice(2)) {
  const [command, path] = args;
  if (args.length !== 2 || !path || !['init', 'serve'].includes(command ?? ''))
    throw new Error('USAGE: accounts-service init|serve /absolute/config.json');
  const config = await loadServiceConfiguration(path);
  if (command === 'init') {
    await initializeService(config);
    process.stdout.write('ACCOUNT_INITIALIZED\n');
    return;
  }
  const running = await startAccountService(config);
  process.stdout.write(`ACCOUNT_LISTENING ${running.baseURL}\n`);
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.on(signal, () => {
      if (stopping)
        return;
      stopping = true;
      void running.stop().then(() => {
        process.stdout.write('ACCOUNT_STOPPED\n');
      }, () => {
        process.stderr.write('ACCOUNT_SHUTDOWN_INCOMPLETE\n');
        process.exit(1);
      });
    });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void runServiceCLI().catch(() => {
    process.stderr.write('ACCOUNT_COMMAND_FAILED\n');
    process.exitCode = 1;
  });
