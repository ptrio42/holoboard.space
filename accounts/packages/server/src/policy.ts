import type { EventTemplate } from "nostr-tools/pure";
import { AccountError } from "./limits.ts";

/** This slice implements bounded kind-1 signing only. Other policies need their own validators. */
export interface SigningPolicy { allowedKinds: readonly number[] }

export function createSigningPolicy(policy: SigningPolicy) {
  if (!Array.isArray(policy.allowedKinds) || policy.allowedKinds.some((kind) => kind !== 1)) {
    throw new Error("Only kind 1 signing is implemented");
  }
  const allowedKinds = Object.freeze([...new Set(policy.allowedKinds)]);
  return {
    allowedKinds,
    validate(input: unknown): EventTemplate {
      const value = exactObject(input, ["kind", "created_at", "content", "tags"]);
      if (!Number.isSafeInteger(value.kind) || Number(value.kind) < 0 ||
          !Number.isSafeInteger(value.created_at) || Number(value.created_at) < 0 ||
          typeof value.content !== "string" || !value.content.isWellFormed() || Buffer.byteLength(value.content, "utf8") > 16384 ||
          !Array.isArray(value.tags) || value.tags.length > 256) throw invalidInput();
      for (const tag of value.tags) {
        if (!Array.isArray(tag) || tag.length > 32 || tag.some((item: unknown) => typeof item !== "string" || !item.isWellFormed() || Buffer.byteLength(item, "utf8") > 2048)) throw invalidInput();
      }
      if (!allowedKinds.includes(Number(value.kind))) throw new AccountError("PERMISSION_DENIED", 403);
      // Snapshot caller data before any asynchronous custody work. Keep every value and tag order.
      return { kind: value.kind as number, created_at: value.created_at as number, content: value.content,
        tags: (value.tags as string[][]).map((tag) => [...tag]) };
    },
  };
}

export function exactObject(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalidInput();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw invalidInput();
  return value;
}
function invalidInput() { return new AccountError("INVALID_INPUT", 400); }
