import { createHash } from "node:crypto";

/**
 * Deterministic JSON serialization with recursively sorted object keys.
 *
 * This mirrors the canonicalization used by the Forge reference gateway
 * (`json.dumps(value, sort_keys=True, separators=(",", ":"))`) so that a
 * hash computed here matches one computed on the Forge side.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortValue(source[key]);
    }
    return sorted;
  }
  return value;
}

/** SHA-256 hex digest of the canonical JSON encoding of `value`. */
export function sha256HexOfJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}
