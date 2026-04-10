/**
 * VidaiMock -> aimock Fixture Converter
 *
 * Core conversion logic. Used by both the CLI (`aimock convert vidaimock`)
 * and the standalone script (`scripts/convert-vidaimock.ts`).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, basename, extname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AimockFixture {
  match: { userMessage: string };
  response: { content: string };
}

export interface AimockFixtureFile {
  fixtures: AimockFixture[];
}

// ---------------------------------------------------------------------------
// Tera template stripping
// ---------------------------------------------------------------------------

/**
 * Strip Tera template syntax and extract a usable response content string.
 *
 * Strategy:
 * 1. If the template looks like JSON, try to pull out the nested
 *    `choices[].message.content` value (the most common VidaiMock pattern).
 * 2. Otherwise fall back to stripping all Tera delimiters and returning the
 *    remaining text with placeholder variable names.
 */
export function stripTeraTemplate(raw: string): string {
  const trimmed = raw.trim();

  // --- Attempt JSON extraction first -----------------------------------
  const contentValue = extractJsonContent(trimmed);
  if (contentValue !== null) return contentValue;

  // --- Fallback: strip Tera syntax -------------------------------------
  let text = trimmed;

  // Remove comment blocks {# ... #}
  text = text.replace(/\{#[\s\S]*?#\}/g, "");

  // Remove block tags {% ... %}
  text = text.replace(/\{%[\s\S]*?%\}/g, "");

  // Replace expression tags {{ expr }} with the expression name
  text = text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, "[$1]");

  // Collapse excessive whitespace but preserve intentional newlines
  text = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");

  return text;
}

/**
 * Try to parse the template as JSON (after substituting Tera expressions with
 * dummy strings) and pull out `choices[0].message.content`.
 */
function extractJsonContent(raw: string): string | null {
  try {
    // Step 1: remove Tera comments and blocks
    let substituted = raw.replace(/\{#[\s\S]*?#\}/g, "").replace(/\{%[\s\S]*?%\}/g, "");

    // Step 2: Replace Tera expressions inside existing JSON strings.
    // Pattern: the expression is already within quotes, e.g. "foo-{{ bar }}-baz"
    // We replace the {{ ... }} with the placeholder without adding extra quotes.
    substituted = substituted.replace(
      /"([^"]*?)\{\{\s*([\w.]+)\s*\}\}([^"]*?)"/g,
      (_, before, varName, after) => `"${before}[${varName}]${after}"`,
    );

    // Step 3: Replace standalone Tera expressions (not inside quotes),
    // e.g. a bare `{{ content }}` used as a JSON value — wrap with quotes.
    substituted = substituted.replace(/\{\{\s*([\w.]+)\s*\}\}/g, '"[$1]"');

    const parsed = JSON.parse(substituted);

    if (
      parsed &&
      Array.isArray(parsed.choices) &&
      parsed.choices.length > 0 &&
      parsed.choices[0]?.message?.content !== undefined
    ) {
      return String(parsed.choices[0].message.content);
    }
  } catch {
    // Not valid JSON even after substitution — fall through
  }
  return null;
}

// ---------------------------------------------------------------------------
// Filename -> match derivation
// ---------------------------------------------------------------------------

/**
 * Derive a `userMessage` match string from the template filename.
 *
 * Examples:
 *   "greeting.tera"       -> "greeting"
 *   "tell_me_a_joke.json" -> "tell me a joke"
 *   "003-weather.txt"     -> "weather"
 */
export function deriveMatchFromFilename(filename: string): string {
  let name = basename(filename, extname(filename));

  // Strip leading numeric prefixes like "003-"
  name = name.replace(/^\d+[-_]/, "");

  // Replace underscores / hyphens with spaces
  name = name.replace(/[-_]+/g, " ");

  return name.trim();
}

// ---------------------------------------------------------------------------
// File / directory conversion
// ---------------------------------------------------------------------------

const TEMPLATE_EXTENSIONS = new Set([
  ".tera",
  ".json",
  ".txt",
  ".html",
  ".jinja",
  ".jinja2",
  ".j2",
]);

export function convertFile(filePath: string): AimockFixture | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    // Unreadable / binary file — skip gracefully
    return null;
  }

  const content = stripTeraTemplate(raw);
  if (!content) return null;

  const match = deriveMatchFromFilename(filePath);
  return { match: { userMessage: match }, response: { content } };
}

export function convertDirectory(dirPath: string): AimockFixture[] {
  const fixtures: AimockFixture[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fixtures;
    throw err; // permission errors, etc. should propagate
  }

  for (const entry of entries.sort()) {
    const fullPath = resolve(dirPath, entry);
    try {
      if (!statSync(fullPath).isFile()) continue;
    } catch {
      continue;
    }

    const ext = extname(entry).toLowerCase();
    if (!TEMPLATE_EXTENSIONS.has(ext)) continue;

    const fixture = convertFile(fullPath);
    if (fixture) fixtures.push(fixture);
  }

  return fixtures;
}
