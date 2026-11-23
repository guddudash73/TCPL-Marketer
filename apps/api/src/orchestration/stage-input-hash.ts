import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys are sorted recursively, so logically equal
 * inputs produce the same input version regardless of key order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

/** SHA-256 hex digest of the canonical input; this is the stage run's input version. */
export function computeStageInputHash(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}
