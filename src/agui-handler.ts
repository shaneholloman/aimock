// ─── AG-UI Handler ───────────────────────────────────────────────────────────
//
// Matching functions, event builders, and SSE writer for AG-UI protocol.

import * as http from "node:http";
import { randomUUID } from "node:crypto";

import type {
  AGUIRunAgentInput,
  AGUIFixtureMatch,
  AGUIFixture,
  AGUIEvent,
  AGUIMessage,
  AGUIRunStartedEvent,
  AGUIRunFinishedEvent,
  AGUIRunErrorEvent,
  AGUITextMessageStartEvent,
  AGUITextMessageContentEvent,
  AGUITextMessageEndEvent,
  AGUITextMessageChunkEvent,
  AGUIToolCallStartEvent,
  AGUIToolCallArgsEvent,
  AGUIToolCallEndEvent,
  AGUIToolCallResultEvent,
  AGUIStateSnapshotEvent,
  AGUIStateDeltaEvent,
  AGUIMessagesSnapshotEvent,
  AGUIStepStartedEvent,
  AGUIStepFinishedEvent,
  AGUIReasoningStartEvent,
  AGUIReasoningMessageStartEvent,
  AGUIReasoningMessageContentEvent,
  AGUIReasoningMessageEndEvent,
  AGUIReasoningEndEvent,
  AGUIActivitySnapshotEvent,
} from "./agui-types.js";

// ─── Matching functions ──────────────────────────────────────────────────────

/**
 * Extract the content of the last message with role "user" from the input.
 */
export function extractLastUserMessage(input: AGUIRunAgentInput): string {
  if (!input.messages || input.messages.length === 0) return "";
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const msg = input.messages[i];
    if (msg.role === "user" && typeof msg.content === "string") {
      return msg.content;
    }
  }
  return "";
}

/**
 * Check whether an input matches a fixture's match criteria.
 * All specified criteria must pass (AND logic).
 */
export function matchesFixture(input: AGUIRunAgentInput, match: AGUIFixtureMatch): boolean {
  if (match.message !== undefined) {
    const text = extractLastUserMessage(input);
    if (typeof match.message === "string") {
      if (!text.includes(match.message)) return false;
    } else {
      if (!match.message.test(text)) return false;
    }
  }

  if (match.toolName !== undefined) {
    const tools = input.tools ?? [];
    if (!tools.some((t) => t.name === match.toolName)) return false;
  }

  if (match.stateKey !== undefined) {
    if (
      input.state === null ||
      input.state === undefined ||
      typeof input.state !== "object" ||
      !(match.stateKey in (input.state as Record<string, unknown>))
    ) {
      return false;
    }
  }

  if (match.predicate !== undefined) {
    if (!match.predicate(input)) return false;
  }

  return true;
}

/**
 * Find the first fixture whose match criteria pass for the given input.
 */
export function findFixture(input: AGUIRunAgentInput, fixtures: AGUIFixture[]): AGUIFixture | null {
  for (const fixture of fixtures) {
    if (matchesFixture(input, fixture.match)) {
      return fixture;
    }
  }
  return null;
}

// ─── Builder options ─────────────────────────────────────────────────────────

export interface AGUIBuildOpts {
  threadId?: string;
  runId?: string;
  parentRunId?: string;
  /** For tool call builder: include a result event */
  result?: string;
}

// ─── Event builders ──────────────────────────────────────────────────────────

function makeRunStarted(opts?: AGUIBuildOpts): AGUIRunStartedEvent {
  return {
    type: "RUN_STARTED",
    threadId: opts?.threadId ?? randomUUID(),
    runId: opts?.runId ?? randomUUID(),
    ...(opts?.parentRunId ? { parentRunId: opts.parentRunId } : {}),
  };
}

function makeRunFinished(started: AGUIRunStartedEvent): AGUIRunFinishedEvent {
  return {
    type: "RUN_FINISHED",
    threadId: started.threadId,
    runId: started.runId,
  };
}

/**
 * Build a complete text message response sequence.
 * [RUN_STARTED, TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END, RUN_FINISHED]
 */
export function buildTextResponse(text: string, opts?: AGUIBuildOpts): AGUIEvent[] {
  const started = makeRunStarted(opts);
  const messageId = randomUUID();
  return [
    started,
    {
      type: "TEXT_MESSAGE_START",
      messageId,
      role: "assistant",
    } as AGUITextMessageStartEvent,
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId,
      delta: text,
    } as AGUITextMessageContentEvent,
    {
      type: "TEXT_MESSAGE_END",
      messageId,
    } as AGUITextMessageEndEvent,
    makeRunFinished(started),
  ];
}

/**
 * Build a text chunk response (single chunk, no start/end envelope).
 * [RUN_STARTED, TEXT_MESSAGE_CHUNK, RUN_FINISHED]
 */
export function buildTextChunkResponse(text: string, opts?: AGUIBuildOpts): AGUIEvent[] {
  const started = makeRunStarted(opts);
  return [
    started,
    {
      type: "TEXT_MESSAGE_CHUNK",
      messageId: randomUUID(),
      role: "assistant",
      delta: text,
    } as AGUITextMessageChunkEvent,
    makeRunFinished(started),
  ];
}

/**
 * Build a tool call response sequence.
 * [RUN_STARTED, TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END, (TOOL_CALL_RESULT)?, RUN_FINISHED]
 */
export function buildToolCallResponse(
  toolName: string,
  args: string,
  opts?: AGUIBuildOpts,
): AGUIEvent[] {
  const started = makeRunStarted(opts);
  const toolCallId = randomUUID();
  const events: AGUIEvent[] = [
    started,
    {
      type: "TOOL_CALL_START",
      toolCallId,
      toolCallName: toolName,
    } as AGUIToolCallStartEvent,
    {
      type: "TOOL_CALL_ARGS",
      toolCallId,
      delta: args,
    } as AGUIToolCallArgsEvent,
    {
      type: "TOOL_CALL_END",
      toolCallId,
    } as AGUIToolCallEndEvent,
  ];

  if (opts?.result !== undefined) {
    events.push({
      type: "TOOL_CALL_RESULT",
      messageId: randomUUID(),
      toolCallId,
      content: opts.result,
      role: "tool",
    } as AGUIToolCallResultEvent);
  }

  events.push(makeRunFinished(started));
  return events;
}

/**
 * Build a state snapshot response.
 * [RUN_STARTED, STATE_SNAPSHOT, RUN_FINISHED]
 */
export function buildStateUpdate(snapshot: unknown, opts?: AGUIBuildOpts): AGUIEvent[] {
  const started = makeRunStarted(opts);
  return [
    started,
    {
      type: "STATE_SNAPSHOT",
      snapshot,
    } as AGUIStateSnapshotEvent,
    makeRunFinished(started),
  ];
}

/**
 * Build a state delta response (JSON Patch).
 * [RUN_STARTED, STATE_DELTA, RUN_FINISHED]
 */
export function buildStateDelta(patches: unknown[], opts?: AGUIBuildOpts): AGUIEvent[] {
  const started = makeRunStarted(opts);
  return [
    started,
    {
      type: "STATE_DELTA",
      delta: patches,
    } as AGUIStateDeltaEvent,
    makeRunFinished(started),
  ];
}

/**
 * Build a messages snapshot response.
 * [RUN_STARTED, MESSAGES_SNAPSHOT, RUN_FINISHED]
 */
export function buildMessagesSnapshot(messages: AGUIMessage[], opts?: AGUIBuildOpts): AGUIEvent[] {
  const started = makeRunStarted(opts);
  return [
    started,
    {
      type: "MESSAGES_SNAPSHOT",
      messages,
    } as AGUIMessagesSnapshotEvent,
    makeRunFinished(started),
  ];
}

/**
 * Build a reasoning response sequence.
 * [RUN_STARTED, REASONING_START, REASONING_MESSAGE_START, REASONING_MESSAGE_CONTENT,
 *  REASONING_MESSAGE_END, REASONING_END, RUN_FINISHED]
 */
export function buildReasoningResponse(text: string, opts?: AGUIBuildOpts): AGUIEvent[] {
  const started = makeRunStarted(opts);
  const messageId = randomUUID();
  return [
    started,
    {
      type: "REASONING_START",
      messageId,
    } as AGUIReasoningStartEvent,
    {
      type: "REASONING_MESSAGE_START",
      messageId,
      role: "reasoning",
    } as AGUIReasoningMessageStartEvent,
    {
      type: "REASONING_MESSAGE_CONTENT",
      messageId,
      delta: text,
    } as AGUIReasoningMessageContentEvent,
    {
      type: "REASONING_MESSAGE_END",
      messageId,
    } as AGUIReasoningMessageEndEvent,
    {
      type: "REASONING_END",
      messageId,
    } as AGUIReasoningEndEvent,
    makeRunFinished(started),
  ];
}

/**
 * Build an activity snapshot response.
 * [RUN_STARTED, ACTIVITY_SNAPSHOT, RUN_FINISHED]
 */
export function buildActivityResponse(
  messageId: string,
  activityType: string,
  content: Record<string, unknown>,
  opts?: AGUIBuildOpts,
): AGUIEvent[] {
  const started = makeRunStarted(opts);
  return [
    started,
    {
      type: "ACTIVITY_SNAPSHOT",
      messageId,
      activityType,
      content,
      replace: true,
    } as AGUIActivitySnapshotEvent,
    makeRunFinished(started),
  ];
}

/**
 * Build an error response.
 * [RUN_STARTED, RUN_ERROR] (no RUN_FINISHED — the run errored)
 */
export function buildErrorResponse(
  message: string,
  code?: string,
  opts?: AGUIBuildOpts,
): AGUIEvent[] {
  const started = makeRunStarted(opts);
  return [
    started,
    {
      type: "RUN_ERROR",
      message,
      ...(code !== undefined ? { code } : {}),
    } as AGUIRunErrorEvent,
  ];
}

/**
 * Build a step-wrapped text response.
 * [RUN_STARTED, STEP_STARTED, TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT,
 *  TEXT_MESSAGE_END, STEP_FINISHED, RUN_FINISHED]
 */
export function buildStepWithText(
  stepName: string,
  text: string,
  opts?: AGUIBuildOpts,
): AGUIEvent[] {
  const started = makeRunStarted(opts);
  const messageId = randomUUID();
  return [
    started,
    {
      type: "STEP_STARTED",
      stepName,
    } as AGUIStepStartedEvent,
    {
      type: "TEXT_MESSAGE_START",
      messageId,
      role: "assistant",
    } as AGUITextMessageStartEvent,
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId,
      delta: text,
    } as AGUITextMessageContentEvent,
    {
      type: "TEXT_MESSAGE_END",
      messageId,
    } as AGUITextMessageEndEvent,
    {
      type: "STEP_FINISHED",
      stepName,
    } as AGUIStepFinishedEvent,
    makeRunFinished(started),
  ];
}

/**
 * Combine multiple builder outputs into a single run.
 * Strips RUN_STARTED/RUN_FINISHED from each input, wraps all inner events
 * in one RUN_STARTED...RUN_FINISHED pair.
 */
export function buildCompositeResponse(
  builderOutputs: AGUIEvent[][],
  opts?: AGUIBuildOpts,
): AGUIEvent[] {
  const started = makeRunStarted(opts);
  const inner: AGUIEvent[] = [];

  for (const events of builderOutputs) {
    for (const event of events) {
      if (event.type !== "RUN_STARTED" && event.type !== "RUN_FINISHED") {
        inner.push(event);
      }
    }
  }

  return [started, ...inner, makeRunFinished(started)];
}

// ─── SSE writer ──────────────────────────────────────────────────────────────

/**
 * Write AG-UI events as an SSE stream to an HTTP response.
 * Sets appropriate headers, serializes each event as `data: {...}\n\n`,
 * and optionally delays between events.
 */
export async function writeAGUIEventStream(
  res: http.ServerResponse,
  events: AGUIEvent[],
  opts?: { delayMs?: number; signal?: AbortSignal },
): Promise<void> {
  const delayMs = opts?.delayMs ?? 0;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  for (const event of events) {
    if (opts?.signal?.aborted) break;
    if (res.socket?.destroyed) break;

    const stamped = { ...event, timestamp: Date.now() };
    try {
      res.write(`data: ${JSON.stringify(stamped)}\n\n`);
    } catch {
      break; // client disconnected or stream error — stop writing
    }

    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (!res.writableEnded) res.end();
}
