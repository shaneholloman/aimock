import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";

// --- helpers ---

function post(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function get(
  url: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "GET",
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function options(url: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "OPTIONS",
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function postRaw(url: string, raw: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(raw),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(raw);
    req.end();
  });
}

function parseSSEEvents(body: string): unknown[] {
  const events: unknown[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ") && line !== "data: [DONE]") {
      events.push(JSON.parse(line.slice(6)));
    }
  }
  return events;
}

// --- fixtures ---

const textFixture: Fixture = {
  match: { userMessage: "hello" },
  response: { content: "Hi there!" },
};

const toolFixture: Fixture = {
  match: { userMessage: "weather" },
  response: {
    toolCalls: [
      {
        name: "get_weather",
        arguments: '{"city":"NYC"}',
      },
    ],
  },
};

const errorFixture: Fixture = {
  match: { userMessage: "fail" },
  response: {
    error: {
      message: "Rate limited",
      type: "rate_limit_error",
      code: "rate_limit",
    },
    status: 429,
  },
};

// Fixture whose response matches no known type guard — exercises the fallback path
const badResponseFixture: Fixture = {
  match: { userMessage: "badtype" },
  response: { content: 42 } as unknown as Fixture["response"],
};

const allFixtures: Fixture[] = [textFixture, toolFixture, errorFixture, badResponseFixture];

// --- tests ---

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => {
      instance!.server.close(() => resolve());
    });
    instance = null;
  }
});

describe("createServer", () => {
  it("returns a listening server with a url", async () => {
    instance = await createServer(allFixtures);
    expect(instance.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(instance.server.listening).toBe(true);
  });

  it("respects custom host and port", async () => {
    instance = await createServer(allFixtures, {
      host: "127.0.0.1",
      port: 0,
    });
    expect(instance.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe("POST /v1/chat/completions", () => {
  it("streams text response as SSE", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");

    const events = parseSSEEvents(res.body);
    expect(events.length).toBeGreaterThanOrEqual(3);

    // First event should have role
    const first = events[0] as {
      choices: [{ delta: { role?: string } }];
    };
    expect(first.choices[0].delta.role).toBe("assistant");

    // Last event should have finish_reason
    const last = events[events.length - 1] as {
      choices: [{ finish_reason: string | null }];
    };
    expect(last.choices[0].finish_reason).toBe("stop");

    // Body ends with [DONE]
    expect(res.body).toContain("data: [DONE]");
  });

  it("streams tool call response as SSE", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "weather" }],
    });

    expect(res.status).toBe(200);
    const events = parseSSEEvents(res.body);
    expect(events.length).toBeGreaterThanOrEqual(3);

    // Look for a tool_calls delta
    const toolEvent = events.find((e) => {
      const ev = e as {
        choices: [{ delta: { tool_calls?: unknown[] } }];
      };
      return ev.choices[0].delta.tool_calls?.length;
    });
    expect(toolEvent).toBeDefined();

    // Last event should have finish_reason "tool_calls"
    const last = events[events.length - 1] as {
      choices: [{ finish_reason: string | null }];
    };
    expect(last.choices[0].finish_reason).toBe("tool_calls");

    expect(res.body).toContain("data: [DONE]");
  });

  it("returns 404 when no fixture matches", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "unknown" }],
    });

    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("No fixture matched");
    expect(body.error.code).toBe("no_fixture_match");
  });

  it("returns error fixture with correct status", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "fail" }],
    });

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Rate limited");
    expect(body.error.code).toBe("rate_limit");
  });

  it("returns 400 for malformed JSON", async () => {
    instance = await createServer(allFixtures);
    const res = await postRaw(`${instance.url}/v1/chat/completions`, "{not valid json");

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Malformed JSON");
    expect(body.error.code).toBe("invalid_json");
  });

  it("uses fixture-level chunkSize override", async () => {
    const bigChunkFixture: Fixture = {
      match: { userMessage: "bigchunk" },
      response: { content: "ABCDEFGHIJ" },
      chunkSize: 5,
    };
    instance = await createServer([bigChunkFixture], { chunkSize: 2 });
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "bigchunk" }],
    });

    expect(res.status).toBe(200);
    const events = parseSSEEvents(res.body);
    // With chunkSize 5 and content "ABCDEFGHIJ" (10 chars):
    // 1 role chunk + 2 content chunks + 1 finish = 4
    expect(events.length).toBe(4);
  });

  it("returns 500 when fixture response matches no known type", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "badtype" }],
    });

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("did not match any known type");

    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.response.status).toBe(500);
    expect(entry!.response.fixture).toBe(badResponseFixture);
  });

  it("uses server-level chunkSize default", async () => {
    const fixture: Fixture = {
      match: { userMessage: "small" },
      response: { content: "ABCD" },
      // no fixture-level chunkSize
    };
    instance = await createServer([fixture], { chunkSize: 2 });
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "small" }],
    });

    expect(res.status).toBe(200);
    const events = parseSSEEvents(res.body);
    // chunkSize 2, content "ABCD":
    // 1 role + 2 content + 1 finish = 4
    expect(events.length).toBe(4);
  });
});

describe("routing", () => {
  it("returns 404 for GET /v1/chat/completions", async () => {
    instance = await createServer(allFixtures);
    const res = await get(`${instance.url}/v1/chat/completions`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for POST to unknown path", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/other/path`, { model: "gpt-4", messages: [] });
    expect(res.status).toBe(404);
  });
});

describe("CORS", () => {
  it("includes CORS headers on POST responses", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("handles OPTIONS preflight", async () => {
    instance = await createServer(allFixtures);
    const res = await options(`${instance.url}/v1/chat/completions`);

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("includes CORS headers on 404 responses", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "unknown" }],
    });

    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("journal", () => {
  it("records successful requests", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(instance.journal.size).toBe(1);
    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v1/chat/completions");
    expect(entry!.body.model).toBe("gpt-4");
    expect(entry!.response.status).toBe(200);
    expect(entry!.response.fixture).toBe(textFixture);
  });

  it("records unmatched requests with null fixture", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "nomatch" }],
    });

    expect(instance.journal.size).toBe(1);
    const entry = instance.journal.getLast();
    expect(entry!.response.status).toBe(404);
    expect(entry!.response.fixture).toBeNull();
  });

  it("records error fixture requests", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "fail" }],
    });

    const entry = instance.journal.getLast();
    expect(entry!.response.status).toBe(429);
    expect(entry!.response.fixture).toBe(errorFixture);
  });

  it("records multiple requests in order", async () => {
    instance = await createServer(allFixtures);
    const url = `${instance.url}/v1/chat/completions`;

    await post(url, {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
    });
    await post(url, {
      model: "gpt-4",
      messages: [{ role: "user", content: "weather" }],
    });

    expect(instance.journal.size).toBe(2);
    const entries = instance.journal.getAll();
    expect(entries[0].response.fixture).toBe(textFixture);
    expect(entries[1].response.fixture).toBe(toolFixture);
  });

  it("captures request headers", async () => {
    instance = await createServer(allFixtures);
    await post(
      `${instance.url}/v1/chat/completions`,
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
      },
      { Authorization: "Bearer sk-test" },
    );

    const entry = instance.journal.getLast();
    expect(entry!.headers["authorization"]).toBe("Bearer sk-test");
  });
});
