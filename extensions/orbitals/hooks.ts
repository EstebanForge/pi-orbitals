// Hook config generators + event normalizer.
// Phase 1: canonical event type + claude-shape normalizer scaffold (so the
// Phase 2 recorder and waitForJob's event-poll path share one schema).
// Phase 2: per-agent config generators (claude settings.json, codex hooks.json,
// agy .agents/hooks.json) + codex/agy normalizers + standalone recorder wiring.

export type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PermissionRequest"
  | "Stop"
  | "SubagentStart"
  | "SubagentStop"
  | "PreInvocation"
  | "PostInvocation"
  | "unknown";

/** Canonical event schema written to events/<jobId>.jsonl. */
export interface CanonicalHookEvent {
  jobId?: string;
  hookEventName: HookEventName;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  turnId?: string;
  sessionId?: string;
  cwd?: string;
  ts: string;
  raw: unknown;
}

/** Extract an orbit job id from arbitrary text (prompt, transcript, etc.). */
export function extractJobIdFromText(text: string): string | undefined {
  const match = String(text || "").match(/orbit job ([0-9a-fA-F-]{36})/i);
  return match?.[1];
}

/**
 * Normalize an agent hook payload (JSON from stdin) to the canonical schema.
 * Phase 1 ships the claude/codex shape (shared `tool_name`/`tool_input`/
 * `hook_event_name`/`session_id`). Phase 2 adds the agy shape
 * (`toolCall.name`/`toolCall.args`/`conversationId`) and per-agent refinements.
 */
export function normalizeHookEvent(
  agent: string,
  payload: Record<string, unknown> = {},
  options: { jobId?: string } = {},
): CanonicalHookEvent {
  const hookEventName = String(
    payload.hook_event_name || payload.hookEventName || "unknown",
  ) as HookEventName;
  const sessionId = String(
    payload.session_id || payload.sessionId || payload.conversationId || "",
  );
  const cwd = payload.cwd ? String(payload.cwd) : undefined;
  const turnId = payload.turn_id ? String(payload.turn_id) : undefined;
  const jobId = options.jobId || extractJobIdFromText(JSON.stringify(payload));

  let toolName: string | undefined;
  let toolInput: unknown;
  let toolResponse: unknown;

  if (agent === "agy") {
    const toolCall = payload.toolCall as { name?: string; args?: unknown } | undefined;
    toolName = toolCall?.name;
    toolInput = toolCall?.args;
    toolResponse = payload.toolResponse;
  } else {
    // claude + codex share this shape.
    toolName = payload.tool_name ? String(payload.tool_name) : undefined;
    toolInput = payload.tool_input;
    toolResponse = payload.tool_response;
  }

  return {
    jobId,
    hookEventName,
    toolName,
    toolInput,
    toolResponse,
    turnId,
    sessionId: sessionId || undefined,
    cwd,
    ts: new Date().toISOString(),
    raw: payload,
  };
}

export {};
