#!/usr/bin/env node
// pi-orbitals hook recorder. Self-contained: invoked as a `command` hook by
// claude / codex / agy. Reads one JSON payload on stdin, attributes it to the
// active orbit job, normalizes the fields to a canonical schema, and appends it
// to <ORBIT_HOME>/events/<jobId>.jsonl. Exits 0 with {suppressOutput:true} so it
// never blocks or alters the agent's loop.
//
// Job attribution (the agent's hook does NOT receive the orbit job id):
//   1. If the payload's prompt/transcript text contains `orbit job <uuid>`,
//      bind the agent's session id -> that job id in hooks/session-map.json.
//   2. Attribute this and later events with the same agent session id to the
//      bound job id.
//   3. If no binding is found, append to events/unattributed.jsonl.
//
// Field normalization is agent-specific (claude/codex share one shape; agy uses
// toolCall.* and conversationId). This is the single source of truth for the
// canonical schema; the extension only READS the resulting JSONL.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const opts = { home: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--home") opts.home = argv[++i];
  }
  return opts;
}

function expandHome(value) {
  if (!value) return "";
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function defaultHome() {
  return process.env.ORBIT_HOME || path.join(os.homedir(), ".pi", "orbitals");
}

function ensureHome(home) {
  const root = expandHome(home);
  for (const sub of ["events", "hooks"]) {
    mkdirSync(path.join(root, sub), { recursive: true });
  }
  return root;
}

function readJson(file, fallback) {
  if (!file || !existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

function extractJobId(text) {
  const match = String(text || "").match(/orbit job ([0-9a-fA-F-]{36})/i);
  return match ? match[1] : undefined;
}

function agentSessionId(payload) {
  return (
    payload.session_id ||
    payload.sessionId ||
    payload.conversationId ||
    payload.conversation_id ||
    ""
  );
}

// Normalize an agent hook payload to the canonical orbit event schema.
function normalize(agent, payload) {
  const hookEventName =
    payload.hook_event_name || payload.hookEventName || "unknown";
  const sessionId = agentSessionId(payload);
  let toolName;
  let toolInput;
  let toolResponse;
  if (agent === "agy") {
    const toolCall = payload.toolCall || {};
    toolName = toolCall.name;
    toolInput = toolCall.args;
    toolResponse = payload.toolResponse;
  } else {
    toolName = payload.tool_name;
    toolInput = payload.tool_input;
    toolResponse = payload.tool_response;
  }
  return {
    agent,
    jobId: undefined,
    hookEventName,
    toolName,
    toolInput,
    toolResponse,
    turnId: payload.turn_id,
    sessionId: sessionId || undefined,
    cwd: payload.cwd,
    ts: new Date().toISOString(),
    raw: payload,
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const home = ensureHome(opts.home || defaultHome());
  const sessionMapPath = path.join(home, "hooks", "session-map.json");

  let raw = "";
  try {
    // Short-lived hook process: read all of stdin synchronously from fd 0.
    raw = readFileSync(0, "utf8");
  } catch {
    raw = "";
  }

  let payload = {};
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { raw };
    }
  }

  // Infer the agent: hooks are configured per-agent, and the command includes
  // the agent as the first positional arg when present.
  const agent = process.env.ORBIT_HOOK_AGENT || payload.__orbit_agent || "claude";

  const map = readJson(sessionMapPath, {});
  const sId = agentSessionId(payload);
  const fromPrompt = extractJobId(payload.prompt) || extractJobId(JSON.stringify(payload));
  if (fromPrompt && sId) map[sId] = fromPrompt;
  const jobId = fromPrompt || (sId ? map[sId] : undefined);
  if (jobId && sId) writeJsonAtomic(sessionMapPath, map);

  const event = normalize(agent, payload);
  event.jobId = jobId || undefined;

  const file = jobId
    ? path.join(home, "events", `${jobId}.jsonl`)
    : path.join(home, "events", "unattributed.jsonl");
  appendFileSync(file, JSON.stringify(event) + "\n");

  // Non-blocking: tell the agent to ignore our stdout.
  process.stdout.write(JSON.stringify({ suppressOutput: true }));
}

try {
  main();
} catch (error) {
  // Never break the agent's hook loop; best-effort only.
  try {
    process.stderr.write(String(error && error.stack ? error.stack : error));
  } catch {}
}
process.exit(0);
