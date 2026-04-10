#!/usr/bin/env tsx

/**
 * VidaiMock -> aimock Fixture Converter (standalone script)
 *
 * Usage:
 *   npx tsx scripts/convert-vidaimock.ts <input-path> [output-path]
 *
 * Core logic lives in src/convert-vidaimock.ts — this script is a thin CLI
 * wrapper. Prefer `npx aimock convert vidaimock` instead.
 */

import { writeFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  convertFile,
  convertDirectory,
  type AimockFixture,
  type AimockFixtureFile,
} from "../src/convert-vidaimock.js";

// Re-export everything the test files import from here
export {
  stripTeraTemplate,
  deriveMatchFromFilename,
  convertFile,
  convertDirectory,
  type AimockFixture,
  type AimockFixtureFile,
} from "../src/convert-vidaimock.js";

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error("Usage: npx tsx scripts/convert-vidaimock.ts <input-path> [output-path]");
    process.exit(1);
  }

  const inputPath = resolve(args[0]);
  const outputPath = args[1] ? resolve(args[1]) : null;

  let fixtures: AimockFixture[];

  try {
    const stat = statSync(inputPath);
    if (stat.isDirectory()) {
      fixtures = convertDirectory(inputPath);
    } else {
      const single = convertFile(inputPath);
      fixtures = single ? [single] : [];
    }
  } catch (err) {
    console.error(`Error reading input path: ${inputPath}`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (fixtures.length === 0) {
    console.error(
      "No fixtures produced — check that the input contains valid VidaiMock templates.",
    );
    process.exit(1);
  }

  const output: AimockFixtureFile = { fixtures };
  const json = JSON.stringify(output, null, 2) + "\n";

  if (outputPath) {
    writeFileSync(outputPath, json, "utf-8");
    console.log(`Wrote ${fixtures.length} fixture(s) to ${outputPath}`);
  } else {
    process.stdout.write(json);
  }
}

// Only run CLI when executed directly (not when imported by tests)
const isDirectExecution =
  process.argv[1]?.endsWith("convert-vidaimock.ts") ||
  process.argv[1]?.endsWith("convert-vidaimock.js");

if (isDirectExecution) {
  main();
}
