// Small helpers shared across the module: model-output validation, JSON-file
// persistence, ID generation, and console formatting.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * Parse a model response that is expected to match a Zod schema.
 * Throws a clear, labelled error if the text is not valid JSON or does not
 * match the schema, so a bad proposal fails loudly at the boundary.
 */
export function safeJsonParse<T>(
  raw: string,
  label: string,
  schema: z.ZodType<T>
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${label} did not return valid JSON. Got:\n${preview(raw, 200)}`
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `${label} returned invalid shape.\n${result.error.toString()}\nRaw:\n${preview(raw, 200)}`
    );
  }

  return result.data;
}

/**
 * Read a JSON array store from disk.
 *
 * - a missing file is treated as an empty store (returns [])
 * - an empty file is treated as an empty store (returns [])
 * - malformed JSON throws a clear, labelled error instead of silently
 *   resetting the data — losing an audit trail quietly is worse than failing
 * - the parsed data is validated against the item schema
 */
export function readJsonArray<T>(
  filePath: string,
  schema: z.ZodType<T>,
  label: string
): T[] {
  if (!existsSync(filePath)) return [];

  const raw = readFileSync(filePath, "utf8").trim();
  if (raw === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${label} store at ${filePath} contains malformed JSON. ` +
        `Fix it by hand or restore a clean state with "npm run reset".`
    );
  }

  const result = z.array(schema).safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `${label} store at ${filePath} has an invalid shape.\n${result.error.toString()}`
    );
  }

  return result.data;
}

/** Write a JSON array store to disk as formatted JSON, creating the folder if needed. */
export function writeJsonArray<T>(filePath: string, items: T[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

/**
 * Next deterministic sequential ID for a prefix (e.g. "APR" -> "APR-001").
 * Derived from the highest existing suffix so IDs stay stable and never collide,
 * even if some records were removed.
 */
export function nextSequentialId(prefix: string, existingIds: string[]): string {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const id of existingIds) {
    const match = id.match(pattern);
    if (match) max = Math.max(max, Number.parseInt(match[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

/** Current time as an ISO string, used for createdAt/updatedAt/timestamps. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Print a labelled section header so each stage is easy to read in the console. */
export function printSection(title: string): void {
  const line = "─".repeat(Math.max(title.length, 12));
  console.log(`\n${line}\n${title}\n${line}`);
}

/** Pretty-print a value as compact, indented JSON for the console. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Truncate long text for previews and error messages. */
export function preview(value: unknown, max = 140): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/**
 * Deterministic JSON serialization: object keys are sorted recursively so the
 * same logical value always produces the same string regardless of key
 * insertion order. Arrays keep their order (order is meaningful there).
 * `undefined` values are dropped, matching JSON.stringify's own behaviour for
 * object properties.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      sorted[key] = canonicalize(entry);
    }
    return sorted;
  }
  return value;
}

/**
 * Content hash of a proposed action: sha256 hex of the canonical JSON of
 * `{ toolName, arguments }`. This is the identity of an approval's payload —
 * two payloads with identical content hash identically regardless of key
 * order, and any change to the content (a different amount, a different
 * field) changes the hash. Approvals bind to this hash, not to a record ID.
 */
export function hashAction(toolName: string, args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalJson({ toolName, arguments: args }))
    .digest("hex");
}
