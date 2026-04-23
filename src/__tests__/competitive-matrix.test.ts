import { describe, it, expect } from "vitest";

// ── Reimplement pure functions from scripts/update-competitive-matrix.ts ─────
// These mirror the logic so we can unit-test without requiring network access
// or dealing with import.meta.dirname in the test runner.

// ── Provider count detection ────────────────────────────────────────────────

const PROVIDER_GROUPS: string[][] = [
  ["openai"],
  ["claude", "anthropic"],
  ["gemini", "google.*ai"],
  ["bedrock", "aws"],
  ["azure"],
  ["vertex"],
  ["ollama"],
  ["cohere"],
  ["mistral"],
  ["groq"],
  ["together"],
  ["llama"],
];

function countProviders(text: string): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const group of PROVIDER_GROUPS) {
    const found = group.some((kw) => new RegExp(kw, "i").test(lower));
    if (found) count++;
  }
  return count;
}

// ── Feature rules (subset needed for tests) ────────────────────────────────

interface FeatureRule {
  rowLabel: string;
  keywords: string[];
}

const FEATURE_RULES: FeatureRule[] = [
  {
    rowLabel: "Chat Completions SSE",
    keywords: ["chat/completions", "streaming", "SSE", "server-sent", "stream.*true"],
  },
  {
    rowLabel: "WebSocket APIs",
    keywords: ["websocket", "realtime", "ws://", "wss://"],
  },
  {
    rowLabel: "Embeddings API",
    keywords: ["embedding", "/v1/embeddings", "embed"],
  },
  {
    rowLabel: "Structured output / JSON mode",
    keywords: ["json_object", "json_schema", "structured output", "response_format"],
  },
];

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// ── Migration page row pattern builder ──────────────────────────────────────

function buildMigrationRowPatterns(rowLabel: string): string[] {
  const patterns = [rowLabel];
  const variants: Record<string, string[]> = {
    "Chat Completions SSE": ["OpenAI Chat Completions", "Streaming SSE"],
    "Responses API SSE": ["OpenAI Responses API"],
    "Claude Messages API": ["Anthropic Claude"],
    "Gemini streaming": ["Google Gemini"],
    "WebSocket APIs": ["WebSocket protocols"],
    "Structured output / JSON mode": ["Structured output / JSON mode", "Structured output"],
    "Sequential / stateful responses": ["Sequential responses"],
    "Docker image": ["Docker"],
    "Fixture files (JSON)": ["Fixture files"],
    "CLI server": ["CLI"],
    "Error injection (one-shot)": ["Error injection"],
    "Request journal": ["Request journal"],
    "Drift detection": ["Drift detection"],
  };
  if (variants[rowLabel]) {
    patterns.push(...variants[rowLabel]);
  }
  return patterns;
}

// ── Provider count update logic ─────────────────────────────────────────────

function updateProviderCounts(
  html: string,
  competitorName: string,
  detectedCount: number,
  changes: string[],
): string {
  let result = html;

  const providerCountRegex = /(\d+)\+?\s*providers/g;
  result = result.replace(providerCountRegex, (match, numStr) => {
    const currentCount = parseInt(numStr, 10);
    if (detectedCount > currentCount) {
      changes.push(`${competitorName}: provider count ${currentCount} -> ${detectedCount}`);
      return `${detectedCount} providers`;
    }
    return match;
  });

  const llmProviderRegex = /(\d+)\+?\s*LLM\s*providers?/g;
  result = result.replace(llmProviderRegex, (match, numStr) => {
    const currentCount = parseInt(numStr, 10);
    if (detectedCount > currentCount) {
      changes.push(`${competitorName}: LLM provider count ${currentCount} -> ${detectedCount}`);
      return `${detectedCount} LLM providers`;
    }
    return match;
  });

  return result;
}

// ── Migration page update logic ─────────────────────────────────────────────

function updateMigrationPage(
  html: string,
  competitorName: string,
  features: Record<string, boolean>,
  providerCount: number,
): { html: string; changes: string[] } {
  let result = html;
  const changes: string[] = [];

  const tableMatch = result.match(
    /<table class="(?:comparison-table|endpoint-table)">([\s\S]*?)<\/table>/,
  );
  if (!tableMatch) {
    return { html: result, changes };
  }

  for (const rule of FEATURE_RULES) {
    if (!features[rule.rowLabel]) continue;

    const rowPatterns = buildMigrationRowPatterns(rule.rowLabel);
    for (const rowPat of rowPatterns) {
      const rowRegex = new RegExp(
        `(<tr>\\s*<td>${escapeRegex(rowPat)}</td>\\s*)<td style="color: var\\(--error\\)">&#10007;</td>`,
      );
      if (rowRegex.test(result)) {
        result = result.replace(rowRegex, `$1<td style="color: var(--accent)">&#10003;</td>`);
        changes.push(`${competitorName}: ${rowPat} ✗ -> ✓`);
      }
    }
  }

  if (providerCount > 0) {
    result = updateProviderCounts(result, competitorName, providerCount, changes);
  }

  return { html: result, changes };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("provider count extraction from README text", () => {
  it("counts distinct providers from a README mentioning several", () => {
    const readme = `
      Supports OpenAI, Anthropic Claude, Google Gemini, AWS Bedrock,
      Azure OpenAI, and Cohere.
    `;
    expect(countProviders(readme)).toBe(6);
  });

  it("de-duplicates overlapping patterns (anthropic + claude = 1)", () => {
    const readme = "Works with Anthropic and Claude models.";
    expect(countProviders(readme)).toBe(1);
  });

  it("de-duplicates aws + bedrock as one provider", () => {
    const readme = "Supports AWS Bedrock for model inference.";
    expect(countProviders(readme)).toBe(1);
  });

  it("returns 0 for text with no provider mentions", () => {
    expect(countProviders("This is a generic testing library.")).toBe(0);
  });

  it("counts all 12 provider groups when all are mentioned", () => {
    const readme = `
      OpenAI, Claude, Gemini, Bedrock, Azure, Vertex AI,
      Ollama, Cohere, Mistral, Groq, Together AI, Llama
    `;
    expect(countProviders(readme)).toBe(12);
  });

  it("is case-insensitive", () => {
    expect(countProviders("OPENAI and ANTHROPIC")).toBe(2);
  });
});

describe("migration page table update logic", () => {
  const SAMPLE_TABLE = `
<table class="comparison-table">
  <thead>
    <tr>
      <th>Capability</th>
      <th>TestComp</th>
      <th>aimock</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>WebSocket protocols</td>
      <td style="color: var(--error)">&#10007;</td>
      <td style="color: var(--accent)">&#10003;</td>
    </tr>
    <tr>
      <td>Streaming SSE</td>
      <td style="color: var(--accent)">&#10003;</td>
      <td style="color: var(--accent)">&#10003;</td>
    </tr>
    <tr>
      <td>Structured output</td>
      <td style="color: var(--error)">&#10007;</td>
      <td style="color: var(--accent)">&#10003;</td>
    </tr>
  </tbody>
</table>`;

  it("updates a No cell to Yes when the feature is detected", () => {
    const features: Record<string, boolean> = {
      "Chat Completions SSE": false,
      "WebSocket APIs": true,
      "Embeddings API": false,
      "Structured output / JSON mode": false,
    };

    const { html, changes } = updateMigrationPage(SAMPLE_TABLE, "TestComp", features, 0);

    // WebSocket protocols row should now show checkmark
    expect(html).toContain(
      '<td>WebSocket protocols</td>\n      <td style="color: var(--accent)">&#10003;</td>',
    );
    expect(changes.length).toBeGreaterThan(0);
    expect(changes[0]).toContain("WebSocket protocols");
  });

  it("does not downgrade an already-yes cell", () => {
    const features: Record<string, boolean> = {
      "Chat Completions SSE": true, // maps to "Streaming SSE" variant
      "WebSocket APIs": false,
      "Embeddings API": false,
      "Structured output / JSON mode": false,
    };

    const { html } = updateMigrationPage(SAMPLE_TABLE, "TestComp", features, 0);

    // Streaming SSE was already ✓, should remain unchanged
    expect(html).toContain(
      '<td>Streaming SSE</td>\n      <td style="color: var(--accent)">&#10003;</td>',
    );
  });

  it("returns no changes when no table is found", () => {
    const noTableHtml = "<html><body><p>No table here</p></body></html>";
    const features: Record<string, boolean> = {
      "WebSocket APIs": true,
      "Chat Completions SSE": false,
      "Embeddings API": false,
      "Structured output / JSON mode": false,
    };

    const { html, changes } = updateMigrationPage(noTableHtml, "TestComp", features, 5);

    expect(html).toBe(noTableHtml);
    expect(changes).toHaveLength(0);
  });

  it("handles endpoint-table class as well as comparison-table", () => {
    const endpointTable = SAMPLE_TABLE.replace("comparison-table", "endpoint-table");
    const features: Record<string, boolean> = {
      "Chat Completions SSE": false,
      "WebSocket APIs": true,
      "Embeddings API": false,
      "Structured output / JSON mode": false,
    };

    const { changes } = updateMigrationPage(endpointTable, "TestComp", features, 0);

    expect(changes.length).toBeGreaterThan(0);
  });

  it("updates multiple features in one pass", () => {
    const features: Record<string, boolean> = {
      "Chat Completions SSE": false,
      "WebSocket APIs": true,
      "Embeddings API": false,
      "Structured output / JSON mode": true,
    };

    const { html, changes } = updateMigrationPage(SAMPLE_TABLE, "TestComp", features, 0);

    // Both WebSocket protocols and Structured output should be updated
    expect(changes.length).toBe(2);
    expect(html).not.toContain("&#10007;");
  });
});

describe("numeric provider claim updates", () => {
  it('updates "5 providers" to "8 providers" when detected count is higher', () => {
    const html = "<p>Supports 5 providers out of the box.</p>";
    const changes: string[] = [];

    const result = updateProviderCounts(html, "TestComp", 8, changes);

    expect(result).toContain("8 providers");
    expect(result).not.toContain("5 providers");
    expect(changes.length).toBe(1);
  });

  it('updates "5+ providers" to "8 providers" (strips the +)', () => {
    const html = "<td>5+ providers</td>";
    const changes: string[] = [];

    const result = updateProviderCounts(html, "TestComp", 8, changes);

    expect(result).toContain("8 providers");
    expect(result).not.toContain("5+");
  });

  it("does not update when detected count is lower or equal", () => {
    const html = "<p>Supports 10 providers.</p>";
    const changes: string[] = [];

    const result = updateProviderCounts(html, "TestComp", 8, changes);

    expect(result).toContain("10 providers");
    expect(changes).toHaveLength(0);
  });

  it("updates N LLM providers pattern", () => {
    const html = "<p>supports 3 LLM providers</p>";
    const changes: string[] = [];

    const result = updateProviderCounts(html, "TestComp", 7, changes);

    expect(result).toContain("7 LLM providers");
    expect(changes.length).toBe(1);
  });

  it("handles no numeric claims gracefully", () => {
    const html = "<p>A great testing tool.</p>";
    const changes: string[] = [];

    const result = updateProviderCounts(html, "TestComp", 5, changes);

    expect(result).toBe(html);
    expect(changes).toHaveLength(0);
  });

  it("handles multiple provider count references in one document", () => {
    const html = `
      <p>Supports 5 providers including OpenAI.</p>
      <td>5+ providers</td>
    `;
    const changes: string[] = [];

    const result = updateProviderCounts(html, "TestComp", 9, changes);

    // Both occurrences should be updated
    expect(result).not.toContain("5 providers");
    expect(result).not.toContain("5+");
    expect((result.match(/9 providers/g) || []).length).toBe(2);
  });

  it("does not change provider count when equal", () => {
    const html = "<td>8 providers</td>";
    const changes: string[] = [];

    const result = updateProviderCounts(html, "TestComp", 8, changes);

    expect(result).toBe(html);
    expect(changes).toHaveLength(0);
  });
});

describe("migration page update with provider counts", () => {
  const PAGE_WITH_COUNTS = `
<p>TestComp supports 5 providers today.</p>
<table class="comparison-table">
  <thead>
    <tr>
      <th>Capability</th>
      <th>TestComp</th>
      <th>aimock</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>LLM providers</td>
      <td>5+</td>
      <td>10+</td>
    </tr>
    <tr>
      <td>WebSocket protocols</td>
      <td style="color: var(--error)">&#10007;</td>
      <td style="color: var(--accent)">&#10003;</td>
    </tr>
  </tbody>
</table>`;

  it("updates both feature cells and provider counts in one call", () => {
    const features: Record<string, boolean> = {
      "Chat Completions SSE": false,
      "WebSocket APIs": true,
      "Embeddings API": false,
      "Structured output / JSON mode": false,
    };

    const { html, changes } = updateMigrationPage(PAGE_WITH_COUNTS, "TestComp", features, 8);

    // Feature cell should be updated
    expect(html).not.toContain("&#10007;");
    // Provider count in prose should be updated
    expect(html).toContain("8 providers");
    expect(changes.length).toBeGreaterThanOrEqual(2);
  });

  it("leaves provider count alone when detected is not higher", () => {
    const features: Record<string, boolean> = {
      "Chat Completions SSE": false,
      "WebSocket APIs": false,
      "Embeddings API": false,
      "Structured output / JSON mode": false,
    };

    const { html, changes } = updateMigrationPage(PAGE_WITH_COUNTS, "TestComp", features, 3);

    // Count should remain as-is
    expect(html).toContain("5 providers");
    expect(changes).toHaveLength(0);
  });
});

describe("buildMigrationRowPatterns", () => {
  it("returns the original label plus variants", () => {
    const patterns = buildMigrationRowPatterns("WebSocket APIs");
    expect(patterns).toContain("WebSocket APIs");
    expect(patterns).toContain("WebSocket protocols");
  });

  it("returns just the label for unknown rules", () => {
    const patterns = buildMigrationRowPatterns("Some Unknown Feature");
    expect(patterns).toEqual(["Some Unknown Feature"]);
  });

  it("returns multiple variants for Chat Completions SSE", () => {
    const patterns = buildMigrationRowPatterns("Chat Completions SSE");
    expect(patterns).toContain("OpenAI Chat Completions");
    expect(patterns).toContain("Streaming SSE");
  });
});

// ── parseCurrentMatrix reimplementation for testing ────────────────────────

function parseCurrentMatrix(html: string): {
  headers: string[];
  rows: Map<string, Map<string, string>>;
} {
  const tableMatch = html.match(/<table class="comparison-table">([\s\S]*?)<\/table>/);
  if (!tableMatch) {
    throw new Error("Could not find comparison-table in HTML");
  }
  const tableHtml = tableMatch[1];

  const thRegex = /<th[^>]*>[\s\S]*?<a[^>]*>(.*?)<\/a[\s\S]*?<\/th>/g;
  const headers: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = thRegex.exec(tableHtml)) !== null) {
    headers.push(m[1].trim());
  }

  const rows = new Map<string, Map<string, string>>();
  const tbody = tableHtml.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  let tr: RegExpExecArray | null;
  const trIter = new RegExp(/<tr>([\s\S]*?)<\/tr>/g);

  while ((tr = trIter.exec(tbody)) !== null) {
    const tds: string[] = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let td: RegExpExecArray | null;
    while ((td = tdRegex.exec(tr[1])) !== null) {
      tds.push(td[1].trim());
    }
    if (tds.length < 2) continue;

    const rowLabel = tds[0];
    const rowMap = new Map<string, string>();
    for (let i = 1; i < tds.length && i - 1 < headers.length; i++) {
      rowMap.set(headers[i - 1], tds[i]);
    }
    rows.set(rowLabel, rowMap);
  }

  return { headers, rows };
}

describe("parseCurrentMatrix header extraction", () => {
  const MATRIX_WITH_LINKS = `
<table class="comparison-table">
  <thead>
    <tr>
      <th>Capability</th>
      <th class="col-aimock"><a href="https://github.com/CopilotKit/aimock">aimock</a></th>
      <th><a href="https://github.com/mswjs/msw">MSW</a></th>
      <th><a href="https://github.com/vidaiUK/VidaiMock">VidaiMock</a></th>
      <th><a href="https://github.com/dwmkerr/mock-llm">mock-llm</a></th>
      <th><a href="https://github.com/piyook/llm-mock">piyook/llm-mock</a></th>
      <th><a href="https://github.com/mokksy/ai-mocks">mokksy/ai-mocks</a></th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Chat Completions SSE</td>
      <td class="col-aimock"><span class="yes">Built-in &#10003;</span></td>
      <td><span class="manual">manual</span></td>
      <td><span class="yes">&#10003;</span></td>
      <td><span class="yes">&#10003;</span></td>
      <td><span class="yes">&#10003;</span></td>
      <td><span class="yes">&#10003;</span></td>
    </tr>
    <tr>
      <td>WebSocket APIs</td>
      <td class="col-aimock"><span class="yes">Built-in &#10003;</span></td>
      <td><span class="no">&#10007;</span></td>
      <td><span class="no">&#10007;</span></td>
      <td><span class="no">&#10007;</span></td>
      <td><span class="no">&#10007;</span></td>
      <td class="no">No</td>
    </tr>
  </tbody>
</table>`;

  it("extracts all 6 competitor headers from linked <th> elements", () => {
    const { headers } = parseCurrentMatrix(MATRIX_WITH_LINKS);
    expect(headers).toHaveLength(6);
    expect(headers).toEqual([
      "aimock",
      "MSW",
      "VidaiMock",
      "mock-llm",
      "piyook/llm-mock",
      "mokksy/ai-mocks",
    ]);
  });

  it("maps each header to the correct column index", () => {
    const { headers } = parseCurrentMatrix(MATRIX_WITH_LINKS);
    expect(headers[0]).toBe("aimock");
    expect(headers[1]).toBe("MSW");
    expect(headers[2]).toBe("VidaiMock");
    expect(headers[3]).toBe("mock-llm");
    expect(headers[4]).toBe("piyook/llm-mock");
    expect(headers[5]).toBe("mokksy/ai-mocks");
  });

  it("correctly parses row data for each competitor column", () => {
    const { rows } = parseCurrentMatrix(MATRIX_WITH_LINKS);
    const chatRow = rows.get("Chat Completions SSE");
    expect(chatRow).toBeDefined();
    expect(chatRow!.get("mokksy/ai-mocks")).toContain("&#10003;");
  });

  it("fails to parse headers when <th> lacks <a> anchor tags", () => {
    const noLinks = MATRIX_WITH_LINKS.replace(/<a[^>]*>(.*?)<\/a>/g, "$1");
    const { headers } = parseCurrentMatrix(noLinks);
    expect(headers).toHaveLength(0);
  });
});
