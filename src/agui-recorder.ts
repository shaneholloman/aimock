import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { AGUIFixture, AGUIRecordConfig, AGUIEvent, AGUIRunAgentInput } from "./agui-types.js";
import { extractLastUserMessage } from "./agui-handler.js";
import type { Logger } from "./logger.js";

/**
 * Proxy an unmatched AG-UI request to a real upstream agent, record the
 * SSE event stream as a fixture on disk and in memory, and relay the
 * response back to the original client in real time.
 *
 * Returns `true` if the request was proxied, `false` if no upstream is configured.
 */
export async function proxyAndRecordAGUI(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  input: AGUIRunAgentInput,
  fixtures: AGUIFixture[],
  config: AGUIRecordConfig,
  logger: Logger,
): Promise<boolean> {
  if (!config.upstream) {
    logger.warn("No upstream URL configured for AG-UI recording — cannot proxy");
    return false;
  }

  let target: URL;
  try {
    target = new URL(config.upstream);
  } catch {
    logger.error(`Invalid upstream AG-UI URL: ${config.upstream}`);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid upstream AG-UI URL" }));
    return true;
  }

  logger.warn(`NO AG-UI FIXTURE MATCH — proxying to ${config.upstream}`);

  // Build upstream request headers
  const forwardHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  // Forward auth headers if present
  const authorization = req.headers["authorization"];
  if (authorization) {
    forwardHeaders["Authorization"] = Array.isArray(authorization)
      ? authorization.join(", ")
      : authorization;
  }
  const apiKey = req.headers["x-api-key"];
  if (apiKey) {
    forwardHeaders["x-api-key"] = Array.isArray(apiKey) ? apiKey.join(", ") : apiKey;
  }

  const requestBody = JSON.stringify(input);

  try {
    await teeUpstreamStream(
      target,
      forwardHeaders,
      requestBody,
      res,
      input,
      fixtures,
      config,
      logger,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown proxy error";
    logger.error(`AG-UI proxy request failed: ${msg}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Upstream AG-UI agent unreachable" }));
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Internal: tee the upstream SSE stream to the client and buffer for recording
// ---------------------------------------------------------------------------

function teeUpstreamStream(
  target: URL,
  headers: Record<string, string>,
  body: string,
  clientRes: http.ServerResponse,
  input: AGUIRunAgentInput,
  fixtures: AGUIFixture[],
  config: AGUIRecordConfig,
  logger: Logger,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === "https:" ? https : http;
    const UPSTREAM_TIMEOUT_MS = 30_000;

    const upstreamReq = transport.request(
      target,
      {
        method: "POST",
        timeout: UPSTREAM_TIMEOUT_MS,
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (upstreamRes) => {
        // Set SSE headers on the client response
        if (!clientRes.headersSent) {
          clientRes.writeHead(upstreamRes.statusCode ?? 200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
        }

        const chunks: Buffer[] = [];

        upstreamRes.on("data", (chunk: Buffer) => {
          // Relay to client in real time
          try {
            clientRes.write(chunk);
          } catch {
            // Client connection may have closed — continue buffering for recording
          }
          // Buffer for fixture construction
          chunks.push(chunk);
        });

        upstreamRes.on("error", (err) => {
          if (!clientRes.headersSent) {
            clientRes.writeHead(502, { "Content-Type": "application/json" });
            clientRes.end(JSON.stringify({ error: "Upstream AG-UI agent unreachable" }));
          } else if (!clientRes.writableEnded) {
            clientRes.end();
          }
          reject(err);
        });

        upstreamRes.on("end", () => {
          if (!clientRes.writableEnded) clientRes.end();

          // Parse buffered SSE events
          const buffered = Buffer.concat(chunks).toString();
          const events = parseSSEEvents(buffered, logger);

          // Build fixture
          const message = extractLastUserMessage(input);
          if (!message) {
            logger.warn("Recorded AG-UI fixture has no message match — it will match ALL requests");
          }
          const fixture: AGUIFixture = {
            match: { message: message || undefined },
            events,
          };

          if (!config.proxyOnly) {
            // Register in memory first (always available even if disk write fails)
            fixtures.push(fixture);

            // Write to disk
            const fixturePath = config.fixturePath ?? "./fixtures/agui-recorded";
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const filename = `agui-${timestamp}-${crypto.randomUUID().slice(0, 8)}.json`;
            const filepath = path.join(fixturePath, filename);

            try {
              fs.mkdirSync(fixturePath, { recursive: true });
              fs.writeFileSync(
                filepath,
                JSON.stringify(
                  { fixtures: [{ match: fixture.match, events: fixture.events }] },
                  null,
                  2,
                ),
                "utf-8",
              );
              logger.warn(`AG-UI response recorded → ${filepath}`);
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Unknown filesystem error";
              logger.error(
                `Failed to save AG-UI fixture to disk: ${msg} (fixture retained in memory)`,
              );
            }
          } else {
            logger.info("Proxied AG-UI request (proxy-only mode)");
          }

          resolve();
        });
      },
    );

    upstreamReq.on("timeout", () => {
      if (!clientRes.writableEnded) clientRes.end();
      upstreamReq.destroy(
        new Error(`Upstream AG-UI request timed out after ${UPSTREAM_TIMEOUT_MS / 1000}s`),
      );
    });

    upstreamReq.on("error", (err) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "Content-Type": "application/json" });
        clientRes.end(JSON.stringify({ error: "Upstream AG-UI agent unreachable" }));
      } else if (!clientRes.writableEnded) {
        clientRes.end();
      }
      reject(err);
    });

    upstreamReq.write(body);
    upstreamReq.end();
  });
}

/**
 * Parse SSE data lines from buffered stream text.
 */
function parseSSEEvents(text: string, logger?: Logger): AGUIEvent[] {
  const events: AGUIEvent[] = [];
  const blocks = text.split("\n\n");
  for (const block of blocks) {
    const lines = block.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const parsed = JSON.parse(line.slice(6)) as AGUIEvent;
          events.push(parsed);
        } catch {
          logger?.warn(`Skipping unparseable SSE data line: ${line.slice(0, 200)}`);
        }
      }
    }
  }
  return events;
}
