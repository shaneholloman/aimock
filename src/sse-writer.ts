import type * as http from "node:http";
import type { SSEChunk } from "./types.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function writeSSEStream(
  res: http.ServerResponse,
  chunks: SSEChunk[],
  latency = 0,
): Promise<void> {
  if (res.writableEnded) return;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  for (const chunk of chunks) {
    if (latency > 0) {
      await delay(latency);
    }
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  if (!res.writableEnded) {
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

export function writeErrorResponse(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}
