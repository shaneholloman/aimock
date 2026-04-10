#!/usr/bin/env tsx

/**
 * mock-llm (dwmkerr) -> aimock fixture converter (standalone script)
 *
 * Usage:
 *   npx tsx scripts/convert-mockllm.ts <input.yaml> [output.json]
 *
 * Core logic lives in src/convert-mockllm.ts — this script is a thin CLI
 * wrapper. Prefer `npx aimock convert mockllm` instead.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSimpleYaml, convertConfig, type MockLLMConfig } from "../src/convert-mockllm.js";

// Re-export everything the test files import from here
export {
  parseSimpleYaml,
  convertConfig,
  type MockLLMRoute,
  type MockLLMTool,
  type MockLLMConfig,
  type AimockFixture,
  type AimockMCPTool,
  type ConvertResult,
} from "../src/convert-mockllm.js";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: npx tsx scripts/convert-mockllm.ts <input.yaml> [output.json]

Converts a mock-llm (dwmkerr) YAML config to aimock fixture JSON.

If output path is omitted, prints JSON to stdout.`);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const inputPath = resolve(args[0]);
  const outputPath = args[1] ? resolve(args[1]) : null;

  let yamlContent: string;
  try {
    yamlContent = readFileSync(inputPath, "utf-8");
  } catch (err) {
    console.error(`Error reading input file: ${(err as Error).message}`);
    process.exit(1);
  }

  const parsed = parseSimpleYaml(yamlContent) as MockLLMConfig | null;
  if (!parsed || typeof parsed !== "object") {
    console.error("Error: could not parse YAML config");
    process.exit(1);
  }

  const result = convertConfig(parsed);

  // Build aimock fixture file
  const fixtureOutput = { fixtures: result.fixtures };
  const fixtureJson = JSON.stringify(fixtureOutput, null, 2);

  if (outputPath) {
    writeFileSync(outputPath, fixtureJson + "\n", "utf-8");
    console.log(`Wrote fixtures to ${outputPath}`);

    // If MCP tools present, write a companion aimock.json config
    if (result.mcpTools) {
      const configPath = outputPath.replace(/\.json$/, ".aimock.json");
      const aimockConfig = {
        llm: { fixtures: outputPath },
        mcp: {
          tools: result.mcpTools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            inputSchema: t.inputSchema ?? {},
            result: `Mock result for ${t.name}`,
          })),
        },
      };
      writeFileSync(configPath, JSON.stringify(aimockConfig, null, 2) + "\n", "utf-8");
      console.log(`Wrote aimock config with MCP tools to ${configPath}`);
    }
  } else {
    console.log(fixtureJson);

    if (result.mcpTools) {
      console.log("\n--- MCP Tools (aimock config format) ---");
      console.log(JSON.stringify({ mcp: { tools: result.mcpTools } }, null, 2));
    }
  }
}

// Only run CLI when executed directly (not imported)
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("convert-mockllm.ts") ||
    process.argv[1].endsWith("convert-mockllm.js"));

if (isDirectRun) {
  main();
}
