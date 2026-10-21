import { CompactEncrypt, compactDecrypt } from "jose";
import { AccountError } from "./limits.ts";

export interface KeyEncryptionConfiguration {
  installationId: string;
  activeKid: string;
  keys: Readonly<Record<string, Uint8Array>>;
}
export function identityUnavailable(): AccountError { return new AccountError("IDENTITY_UNAVAILABLE", 503); }

/** A local-only keyring. No header-controlled URL or remote key resolution. */
export function createKeyEncryption(config: KeyEncryptionConfiguration) {
  if (!config.installationId || config.installationId.length > 200) throw new Error("Invalid custody installation ID");
  const { installationId, activeKid } = config;
  const keys = new Map<string, Uint8Array>();
  for (const [kid, key] of Object.entries(config.keys)) {
    if (!kid || kid.length > 128 || !(key instanceof Uint8Array) || key.byteLength !== 32) throw new Error("Custody encryption keys must be 32 bytes with explicit key IDs");
    keys.set(kid, new Uint8Array(key));
  }
  if (!keys.has(activeKid)) throw new Error("Active custody encryption key is missing");
  return {
    async encrypt(plaintext: Uint8Array, accountId: string, purpose: string): Promise<string> {
      return new CompactEncrypt(plaintext).setProtectedHeader({
        alg: "dir", enc: "A256GCM", kid: activeKid,
        installation: installationId, account: accountId, purpose, version: 1,
      }).encrypt(keys.get(activeKid)!);
    },
    async decrypt(ciphertext: string, accountId: string, purpose: string): Promise<Uint8Array> {
      try {
        const { plaintext, protectedHeader: header } = await compactDecrypt(ciphertext, (header) => {
          const key = typeof header.kid === "string" ? keys.get(header.kid) : undefined;
          if (!key) throw identityUnavailable();
          return key;
        }, { keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"] });
        // Binding fields are trusted only after authenticated decryption.
        if (header.installation !== installationId || header.account !== accountId || header.purpose !== purpose || header.version !== 1) {
          plaintext.fill(0); throw identityUnavailable();
        }
        return plaintext;
      } catch { throw identityUnavailable(); }
    },
  };
}
