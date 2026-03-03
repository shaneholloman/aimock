import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { MockOpenAI } from "../mock-openai.js";
import { Journal } from "../journal.js";

// ---- Helpers ----

const FIXTURES_DIR = resolve(import.meta.dirname, "../../fixtures");

function post(url: string, body: object): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, data }));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function chatBody(userMessage: string, stream = true) {
  return {
    model: "gpt-4",
    messages: [{ role: "user", content: userMessage }],
    stream,
  };
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mock-openai-test-"));
}

// ---- Tests ----

describe("MockOpenAI", () => {
  let mock: MockOpenAI | null = null;

  afterEach(async () => {
    if (mock) {
      try {
        await mock.stop();
      } catch {
        // already stopped
      }
      mock = null;
    }
  });

  describe("constructor", () => {
    it("creates an instance with default options", () => {
      mock = new MockOpenAI();
      expect(mock).toBeInstanceOf(MockOpenAI);
    });

    it("accepts custom options", () => {
      mock = new MockOpenAI({
        port: 0,
        host: "127.0.0.1",
        latency: 50,
      });
      expect(mock).toBeInstanceOf(MockOpenAI);
    });
  });

  describe("fixture management", () => {
    it("addFixture adds a fixture and returns this", () => {
      mock = new MockOpenAI();
      const result = mock.addFixture({
        match: { userMessage: "hello" },
        response: { content: "Hi!" },
      });
      expect(result).toBe(mock);
    });

    it("addFixtures adds multiple fixtures and returns this", () => {
      mock = new MockOpenAI();
      const result = mock.addFixtures([
        {
          match: { userMessage: "a" },
          response: { content: "A" },
        },
        {
          match: { userMessage: "b" },
          response: { content: "B" },
        },
      ]);
      expect(result).toBe(mock);
    });

    it("chaining API works across multiple calls", () => {
      mock = new MockOpenAI();
      const result = mock
        .addFixture({
          match: { userMessage: "hello" },
          response: { content: "Hi!" },
        })
        .addFixtures([
          {
            match: { userMessage: "bye" },
            response: { content: "Bye!" },
          },
        ]);
      expect(result).toBe(mock);
    });

    it("clearFixtures empties all fixtures and returns this", async () => {
      mock = new MockOpenAI();
      mock.addFixture({
        match: { userMessage: "hello" },
        response: { content: "Hi!" },
      });

      const result = mock.clearFixtures();
      expect(result).toBe(mock);

      // Start server — with no fixtures, requests should get 404
      await mock.start();
      const res = await post(mock.url, chatBody("hello"));
      expect(res.status).toBe(404);
    });

    it("on() shorthand adds a fixture", async () => {
      mock = new MockOpenAI();
      mock.on({ userMessage: "on-test" }, { content: "on response" });

      await mock.start();
      const res = await post(mock.url, chatBody("on-test"));
      expect(res.status).toBe(200);
      expect(res.data).toContain("on response");
    });

    it("on() shorthand passes latency and chunkSize opts", async () => {
      mock = new MockOpenAI();
      mock.on({ userMessage: "opts-test" }, { content: "response" }, { latency: 0, chunkSize: 5 });

      await mock.start();
      const res = await post(mock.url, chatBody("opts-test"));
      expect(res.status).toBe(200);
    });
  });

  describe("loadFixtureFile", () => {
    it("loads fixtures from a JSON file", async () => {
      mock = new MockOpenAI();
      mock.loadFixtureFile(join(FIXTURES_DIR, "example-greeting.json"));

      await mock.start();
      const res = await post(mock.url, chatBody("hello"));
      expect(res.status).toBe(200);
      expect(res.data).toContain("Hello!");
    });

    it("returns this for chaining", () => {
      mock = new MockOpenAI();
      const result = mock.loadFixtureFile(join(FIXTURES_DIR, "example-greeting.json"));
      expect(result).toBe(mock);
    });
  });

  describe("loadFixtureDir", () => {
    it("loads all JSON fixtures from a directory", async () => {
      mock = new MockOpenAI();
      mock.loadFixtureDir(FIXTURES_DIR);

      await mock.start();

      // example-greeting.json has a "hello" fixture
      const res = await post(mock.url, chatBody("hello"));
      expect(res.status).toBe(200);
      expect(res.data).toContain("Hello!");
    });

    it("returns this for chaining", () => {
      mock = new MockOpenAI();
      const result = mock.loadFixtureDir(FIXTURES_DIR);
      expect(result).toBe(mock);
    });

    it("loads from a temp directory with custom fixtures", async () => {
      const tmpDir = makeTmpDir();
      try {
        writeFileSync(
          join(tmpDir, "custom.json"),
          JSON.stringify({
            fixtures: [
              {
                match: { userMessage: "custom" },
                response: { content: "custom response" },
              },
            ],
          }),
        );

        mock = new MockOpenAI();
        mock.loadFixtureDir(tmpDir);

        await mock.start();
        const res = await post(mock.url, chatBody("custom"));
        expect(res.status).toBe(200);
        expect(res.data).toContain("custom response");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("server lifecycle", () => {
    it("start returns a URL", async () => {
      mock = new MockOpenAI();
      mock.addFixture({
        match: { userMessage: "hello" },
        response: { content: "Hi!" },
      });

      const url = await mock.start();
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it("start throws if server already started", async () => {
      mock = new MockOpenAI();
      await mock.start();
      await expect(mock.start()).rejects.toThrow("Server already started");
    });

    it("stop closes the server", async () => {
      mock = new MockOpenAI();
      mock.addFixture({
        match: { userMessage: "hello" },
        response: { content: "Hi!" },
      });

      await mock.start();
      const url = mock.url;
      await mock.stop();
      mock = null; // prevent afterEach double-stop

      // Making a request to the stopped server should fail
      await expect(post(url, chatBody("hello"))).rejects.toThrow();
    });

    it("stop throws if server not started", async () => {
      mock = new MockOpenAI();
      await expect(mock.stop()).rejects.toThrow("Server not started");
    });

    it("can restart after stop", async () => {
      mock = new MockOpenAI();
      mock.addFixture({
        match: { userMessage: "hello" },
        response: { content: "Hi!" },
      });

      await mock.start();
      await mock.stop();
      mock = null; // clear for safety

      mock = new MockOpenAI();
      mock.addFixture({
        match: { userMessage: "hello" },
        response: { content: "Hi again!" },
      });
      await mock.start();

      const res = await post(mock.url, chatBody("hello"));
      expect(res.status).toBe(200);
      expect(res.data).toContain("Hi again!");
    });
  });

  describe("url getter", () => {
    it("throws before server is started", () => {
      mock = new MockOpenAI();
      expect(() => mock!.url).toThrow("Server not started");
    });

    it("returns url after server is started", async () => {
      mock = new MockOpenAI();
      await mock.start();
      expect(mock.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });
  });

  describe("journal getter", () => {
    it("throws before server is started", () => {
      mock = new MockOpenAI();
      expect(() => mock!.journal).toThrow("Server not started");
    });

    it("returns a Journal instance after start", async () => {
      mock = new MockOpenAI();
      await mock.start();
      expect(mock.journal).toBeInstanceOf(Journal);
    });

    it("journal records requests", async () => {
      mock = new MockOpenAI();
      mock.addFixture({
        match: { userMessage: "journal-test" },
        response: { content: "recorded" },
      });

      await mock.start();
      await post(mock.url, chatBody("journal-test"));

      expect(mock.journal.size).toBe(1);
      const entry = mock.journal.getLast();
      expect(entry).not.toBeNull();
      expect(entry!.body.messages[0].content).toBe("journal-test");
    });
  });

  describe("request handling", () => {
    it("serves a streaming text response", async () => {
      mock = new MockOpenAI();
      mock.addFixture({
        match: { userMessage: "stream" },
        response: { content: "streamed content" },
      });

      await mock.start();
      const res = await post(mock.url, chatBody("stream", true));
      expect(res.status).toBe(200);
      expect(res.data).toContain("streamed content");
      expect(res.data).toContain("[DONE]");
    });

    it("returns 404 when no fixture matches", async () => {
      mock = new MockOpenAI();
      mock.addFixture({
        match: { userMessage: "hello" },
        response: { content: "Hi!" },
      });

      await mock.start();
      const res = await post(mock.url, chatBody("no-match-here"));
      expect(res.status).toBe(404);
    });

    it("fixtures added after start are visible", async () => {
      mock = new MockOpenAI();
      await mock.start();

      // No fixtures yet — should 404
      const res1 = await post(mock.url, chatBody("late-add"));
      expect(res1.status).toBe(404);

      // Add a fixture after start
      mock.addFixture({
        match: { userMessage: "late-add" },
        response: { content: "late response" },
      });

      // Now it should match
      const res2 = await post(mock.url, chatBody("late-add"));
      expect(res2.status).toBe(200);
      expect(res2.data).toContain("late response");
    });
  });

  describe("static create()", () => {
    it("creates and starts a server", async () => {
      mock = await MockOpenAI.create();
      expect(mock.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(mock.journal).toBeInstanceOf(Journal);
    });

    it("accepts options", async () => {
      mock = await MockOpenAI.create({
        host: "127.0.0.1",
        port: 0,
      });
      expect(mock.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it("allows adding fixtures after creation", async () => {
      mock = await MockOpenAI.create();
      mock.addFixture({
        match: { userMessage: "factory-test" },
        response: { content: "factory response" },
      });

      const res = await post(mock.url, chatBody("factory-test"));
      expect(res.status).toBe(200);
      expect(res.data).toContain("factory response");
    });
  });
});
