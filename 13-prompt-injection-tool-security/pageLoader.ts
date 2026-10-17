import { readFileSync } from "node:fs";
import path from "node:path";

import { DEMO_PAGE_URL, FIXTURES_DIR } from "./config.js";
import { ExternalContentSchema, type ExternalContent } from "./types.js";
import { normalizeUrl, sha256 } from "./utils.js";

// An offline stand-in for "the web". The same URL can serve different content
// depending on the scenario — exactly what happens when an attacker edits a
// page the user trusts. Nothing in this file touches the network: the only
// URL it knows is DEMO_PAGE_URL, and it serves that from a local file.

export const PAGE_VARIANTS = ["normal", "injected", "role-spoofing"] as const;
export type PageVariant = (typeof PAGE_VARIANTS)[number];

// A fixed allowlist of fixture files. Callers pick a variant name; they can
// never pass a file path, so nothing outside ./fixtures can be read.
const FIXTURE_FILES: Record<PageVariant, string> = {
  normal: "normal-page.html",
  injected: "injected-page.html",
  "role-spoofing": "role-spoofing-page.html",
};

export function isPageVariant(value: string): value is PageVariant {
  return (PAGE_VARIANTS as readonly string[]).includes(value);
}

/** Raw HTML of a fixture. */
export function loadFixtureHtml(variant: PageVariant): string {
  return readFileSync(path.join(FIXTURES_DIR, FIXTURE_FILES[variant]), "utf8");
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&rsaquo;": "›",
  "&euro;": "€",
  "&copy;": "©",
};

/**
 * Turn HTML into the plain text an agent would be given.
 *
 * Like most real scrapers (and like Module 05), this keeps the text of every
 * element regardless of CSS. A `display:none` block is invisible to a human
 * visiting the page but fully visible here — which is exactly how a hidden
 * prompt injection reaches a model. Only comments, <script>, <style>, and
 * <head> are dropped.
 */
export function extractReadableText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const decode = (s: string) => s.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e);

  const text = decode(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|ul|ol|section|article|header|footer)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");

  return { title: titleMatch ? decode(titleMatch[1]).trim() : "", text };
}

/**
 * Load a fixture as structured, labelled external content. The result always
 * carries its source and `trust: "untrusted"` — it is never flattened into an
 * anonymous string that could be mistaken for an instruction.
 */
export function loadExternalPage(variant: PageVariant, url: string): ExternalContent {
  const html = loadFixtureHtml(variant);
  const { title, text } = extractReadableText(html);
  const parsed = new URL(url);

  return ExternalContentSchema.parse({
    // Derived from the URL, not the fixture name: a live model must not be
    // able to tell an "injected" fixture from a "normal" one by its label.
    sourceId: `web:${parsed.host}${parsed.pathname}`,
    sourceUrl: url,
    fixturePath: `fixtures/${FIXTURE_FILES[variant]}`,
    trust: "untrusted",
    contentType: "text/html",
    title,
    text,
    metadata: { charCount: text.length, sha256: sha256(text) },
  });
}

/** The offline web the readWebPage tool reads from. */
export interface FixtureWeb {
  readonly variant: PageVariant;
  fetchPage(url: string): ExternalContent;
}

export function createFixtureWeb(variant: PageVariant): FixtureWeb {
  return {
    variant,
    fetchPage(url: string): ExternalContent {
      if (normalizeUrl(url) !== normalizeUrl(DEMO_PAGE_URL)) {
        throw new Error(
          `No offline fixture is registered for ${url}. This demo never fetches from the network.`
        );
      }
      return loadExternalPage(variant, url);
    },
  };
}
