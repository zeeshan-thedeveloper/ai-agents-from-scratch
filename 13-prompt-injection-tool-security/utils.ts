// Small helpers shared across the module: hashing, URL normalisation, secret
// redaction, the offline network guard, and console formatting.

import { createHash } from "node:crypto";

/** SHA-256 hex digest of a string. Used to fingerprint loaded content. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Canonical form of a URL for comparisons, or null when it is not a URL.
 * `new URL(...).href` lower-cases the host and resolves trivial differences,
 * so "HTTPS://Support.Example.com/x" and "https://support.example.com/x"
 * compare equal and cannot be used to slip past a scope check.
 */
export function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/** Recursively freeze an object so nothing downstream can mutate it. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Secret redaction (audit safety)
// ─────────────────────────────────────────────────────────────────────────────

const SECRET_KEY = /(api[-_]?key|secret|token|password|authorization|credential)/i;
const SECRET_VALUE = /\bsk-[A-Za-z0-9_-]{8,}/g;

/**
 * Deep-copy a value with anything secret-looking replaced by "[REDACTED]".
 * Applied to every audit event before it is stored. The module never puts a
 * credential into the audit trace on purpose; this is the backstop for the
 * day someone does by accident.
 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[REDACTED]");
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactSecrets(child);
    }
    return out;
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Offline guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace global `fetch` with a function that throws. Called by every offline
 * demo and by the test suite, so even the intentionally vulnerable path runs
 * in a process where an HTTP call fails loudly instead of leaving the machine.
 *
 * This is belt-and-braces: no tool in this module imports a network client in
 * the first place — sendReport only appends to an in-memory array.
 */
export function blockNetworkAccess(): void {
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(
      `Network access is disabled in offline demo mode (attempted: ${String(input)}).`
    );
  }) as typeof fetch;
}

// ─────────────────────────────────────────────────────────────────────────────
// Console formatting
// ─────────────────────────────────────────────────────────────────────────────

/** Print a labelled section header so each stage is easy to read in the console. */
export function printSection(title: string): void {
  const line = "─".repeat(Math.max(title.length, 12));
  console.log(`\n${line}\n${title}\n${line}`);
}

/** Print a heavier banner for the start of each demo. */
export function printBanner(title: string): void {
  const line = "═".repeat(Math.max(title.length + 4, 12));
  console.log(`\n\n${line}\n  ${title}\n${line}`);
}

/** Pretty-print a value as indented JSON for the console. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Shorten long text for one-line display. */
export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
