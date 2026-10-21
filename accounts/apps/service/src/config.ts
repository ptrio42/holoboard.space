import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { AccountServerConfiguration } from '@holoboard/accounts-server';
export class ServiceConfigurationError extends Error {
  constructor() {
    super('INVALID_SERVICE_CONFIGURATION');
    this.name = 'ServiceConfigurationError';
  }
}
export async function readPrivateFile(path: string, maximum = 65536): Promise<Buffer> {
  try {
    if (!isAbsolute(path))
      throw new Error();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maximum || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
        throw new Error();
      const data = Buffer.alloc(maximum + 1);
      let offset = 0;
      while (offset < data.length) {
        const part = await file.read(data, offset, data.length - offset, null);
        if (part.bytesRead === 0)
          break;
        offset += part.bytesRead;
      }
      if (offset > maximum)
        throw new Error();
      return data.subarray(0, offset);
    }
    finally {
      await file.close();
    }
  }
  catch {
    throw new ServiceConfigurationError();
  }
}
export interface ServiceConfiguration {
  account: AccountServerConfiguration;
  listenHost: '127.0.0.1' | '::1';
  port: number;
  tls: {
    key: Buffer;
    cert: Buffer;
  };
  developmentCapturePath?: string;
  mailIntervalMs: number;
  shutdownTimeoutMs: number;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096)
    throw new Error();
  return value;
}
function file(value: unknown): string {
  const path = text(value);
  if (!isAbsolute(path))
    throw new Error();
  return path;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32)
    throw new Error();
  return value.map(text);
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max)
    throw new Error();
  return Number(value);
}
/** Secret files are separate, bounded, owner-only regular files. Serving never generates missing keys. */
export async function loadServiceConfiguration(path: string): Promise<ServiceConfiguration> {
  try {
    const config = object(JSON.parse((await readPrivateFile(path)).toString('utf8')));
    const known = ['databasePath', 'baseURL', 'basePath', 'trustedOrigins', 'returnURLs', 'installationId', 'inventoryPath', 'authSecretPath', 'keyringPath', 'tls', 'listenHost', 'port', 'explicitExportEnabled', 'developmentCapturePath', 'mailIntervalMs', 'shutdownTimeoutMs'];
    if (Object.keys(config).some(key => !known.includes(key)))
      throw new Error();
    const authSecretPath = file(config.authSecretPath), keyringPath = file(config.keyringPath);
    if (authSecretPath === keyringPath)
      throw new Error();
    const secret = (await readPrivateFile(authSecretPath, 1024)).toString('utf8').trim();
    if (secret.length < 32)
      throw new Error();
    const keyring = object(JSON.parse((await readPrivateFile(keyringPath)).toString('utf8'))), keyValues = object(keyring.keys), keys: Record<string, Uint8Array> = {};
    if (Object.keys(keyValues).length < 1 || Object.keys(keyValues).length > 16)
      throw new Error();
    for (const [id, key] of Object.entries(keyValues)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key))
        throw new Error();
      keys[id] = new Uint8Array(Buffer.from(key, 'hex'));
    }
    const activeKid = text(keyring.activeKid);
    if (!keys[activeKid])
      throw new Error();
    const baseURL = text(config.baseURL), url = new URL(baseURL);
    if (url.origin !== baseURL || url.protocol !== 'https:')
      throw new Error();
    const listenHost = config.listenHost;
    if (listenHost !== '127.0.0.1' && listenHost !== '::1')
      throw new Error();
    const port = integer(config.port, 1024, 65535);
    if (url.hostname !== (listenHost === '::1' ? '[::1]' : listenHost) || Number(url.port || 443) !== port)
      throw new Error();
    if (config.explicitExportEnabled !== undefined && typeof config.explicitExportEnabled !== 'boolean')
      throw new Error();
    const tls = object(config.tls), key = await readPrivateFile(file(tls.keyPath)), cert = await readPrivateFile(file(tls.certPath));
    const trustedOrigins = strings(config.trustedOrigins), returnURLs = strings(config.returnURLs);
    for (const origin of trustedOrigins) {
      const u = new URL(origin);
      if (u.origin !== origin || u.protocol !== 'https:')
        throw new Error();
    }
    for (const target of returnURLs) {
      const u = new URL(target);
      if (!trustedOrigins.includes(u.origin) || u.search || u.hash || u.username || u.password)
        throw new Error();
    }
    const basePath = config.basePath === undefined ? undefined : text(config.basePath);
    if (basePath && !/^\/[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9-]+)*$/.test(basePath))
      throw new Error();
    return { account: { databasePath: file(config.databasePath), baseURL, ...(basePath ? { basePath } : {}), secret, trustedOrigins, returnURLs, custody: { installationId: text(config.installationId), inventoryPath: file(config.inventoryPath), encryption: { activeKid, keys } }, signingPolicy: { allowedKinds: [1] }, explicitExportEnabled: config.explicitExportEnabled === true }, listenHost, port, tls: { key, cert }, ...(config.developmentCapturePath ? { developmentCapturePath: file(config.developmentCapturePath) } : {}), mailIntervalMs: integer(config.mailIntervalMs ?? 1000, 50, 60000), shutdownTimeoutMs: integer(config.shutdownTimeoutMs ?? 10000, 50, 30000) };
  }
  catch {
    throw new ServiceConfigurationError();
  }
}
