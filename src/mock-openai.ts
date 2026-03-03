import type { Fixture, FixtureMatch, FixtureResponse, MockServerOptions } from "./types.js";
import { createServer, type ServerInstance } from "./server.js";
import { loadFixtureFile, loadFixturesFromDir } from "./fixture-loader.js";
import { Journal } from "./journal.js";

export class MockOpenAI {
  private fixtures: Fixture[] = [];
  private serverInstance: ServerInstance | null = null;
  private options: MockServerOptions;

  constructor(options?: MockServerOptions) {
    this.options = options ?? {};
  }

  // ---- Fixture management ----

  addFixture(fixture: Fixture): this {
    this.fixtures.push(fixture);
    return this;
  }

  addFixtures(fixtures: Fixture[]): this {
    this.fixtures.push(...fixtures);
    return this;
  }

  loadFixtureFile(filePath: string): this {
    this.fixtures.push(...loadFixtureFile(filePath));
    return this;
  }

  loadFixtureDir(dirPath: string): this {
    this.fixtures.push(...loadFixturesFromDir(dirPath));
    return this;
  }

  // Uses length = 0 to preserve array reference identity — the running
  // server reads this same array on every request.
  clearFixtures(): this {
    this.fixtures.length = 0;
    return this;
  }

  // ---- Convenience ----

  on(
    match: FixtureMatch,
    response: FixtureResponse,
    opts?: { latency?: number; chunkSize?: number },
  ): this {
    return this.addFixture({
      match,
      response,
      ...opts,
    });
  }

  // ---- Server lifecycle ----

  async start(): Promise<string> {
    if (this.serverInstance) {
      throw new Error("Server already started");
    }
    this.serverInstance = await createServer(this.fixtures, this.options);
    return this.serverInstance.url;
  }

  async stop(): Promise<void> {
    if (!this.serverInstance) {
      throw new Error("Server not started");
    }
    const { server } = this.serverInstance;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    this.serverInstance = null;
  }

  // ---- Accessors ----

  get journal(): Journal {
    if (!this.serverInstance) {
      throw new Error("Server not started");
    }
    return this.serverInstance.journal;
  }

  get url(): string {
    if (!this.serverInstance) {
      throw new Error("Server not started");
    }
    return this.serverInstance.url;
  }

  // ---- Static factory ----

  static async create(options?: MockServerOptions): Promise<MockOpenAI> {
    const instance = new MockOpenAI(options);
    await instance.start();
    return instance;
  }
}
