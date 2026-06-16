/**
 * Pi provider: expose claude/codex/agy tmux sessions as Pi models.
 *
 * Each `streamSimple` call delegates one assistant turn to a peer agent running
 * in a durable tmux pane. Hook events stream back as thinking deltas (progress
 * visibility); the peer's done.json `final_response` becomes the text reply.
 *
 * Scope note: peer agents (claude/codex/agy) have their own full toolsets via
 * bypass flags, so the bidirectional Pi-native-tool bridge is intentionally
 * omitted (YAGNI). The peer does real work in the cwd; Pi just gets the answer.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import path from "node:path";

import { startSession, sendPrompt, refreshJob } from "./jobs.ts";
import { readHookEvents } from "./hooks.ts";
import { getJob, getSession, DEFAULT_HOME } from "./state.ts";
import { defaultModel, getProfile } from "./profiles.ts";
import { sessionExists, sendKeys } from "./tmux.ts";

export const PROVIDER_ID = "orbitals";
const PROVIDER_API = "orbitals-api";

/** Active provider sessions keyed by cwd::agent so we reuse the tmux pane. */
const providerSessions = new Map<string, { name: string; agent: string }>();

export function registerProvider(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER_ID, {
    name: "Orbitals (peer agents over tmux)",
    baseUrl: "tmux://orbitals",
    apiKey: "orbitals-local",
    api: PROVIDER_API,
    models: [
      providerModel("claude", "Claude (orbitals tmux)"),
      providerModel("codex", "Codex (orbitals tmux)"),
      providerModel("agy", "Antigravity (orbitals tmux)"),
    ],
    streamSimple: (model, context, options) =>
      streamOrbital(model, context, options),
  });
}

function providerModel(id: string, name: string) {
  return {
    id,
    name,
    reasoning: true,
    thinkingLevelMap: {
      off: "medium",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
    },
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  };
}

/** Get-or-create a reusable provider tmux session for this cwd+agent. */
function getProviderSession(cwd: string, agent: string) {
  const key = `${path.resolve(cwd)}::${agent}`;
  const existing = providerSessions.get(key);
  // Reuse only if both the state record AND the live tmux pane exist. A dead
  // peer (crash, OOM) leaves a stale state record; fall through to re-launch.
  if (existing && getSession(existing.name, DEFAULT_HOME) && sessionExists(getSession(existing.name, DEFAULT_HOME).tmuxSession)) {
    return existing.name;
  }
  const name = `provider-${agent}-${slug(path.basename(cwd))}`;
  startSession({
    agent,
    name,
    cwd,
    model: defaultModel(agent as any),
    home: DEFAULT_HOME,
    // Provider mode needs hook events for thinking-delta streaming.
    hooks: true,
  });
  providerSessions.set(key, { name, agent });
  return name;
}

function streamOrbital(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: output });

  // Async driver: delegates the turn, pushes events, ends the stream.
  (async () => {
    try {
      const { text } = await runTurn(model, context, options, output, stream);
      endThinking(output, stream);
      startText(output, stream);
      appendText(output, stream, text);
      const idx = output.content.length - 1;
      const block = output.content[idx];
      const finalText = block && block.type === "text" ? block.text : text;
      stream.push({ type: "text_end", contentIndex: idx, content: finalText, partial: output });
      stream.push({ type: "done", reason: "stop", message: output });
    } catch (error: unknown) {
      output.stopReason = "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: "error", error: output });
    } finally {
      stream.end();
    }
  })();

  return stream;
}

async function runTurn(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): Promise<{ text: string }> {
  const agent = model.id; // "claude" | "codex" | "agy"
  const cwd = process.cwd();

  const session = getProviderSession(cwd, agent);
  const prompt = buildProviderPrompt(context, agent);

  const sent = await sendPrompt({
    session,
    prompt,
    wait: false,
    home: DEFAULT_HOME,
  });

  // Poll hook events for thinking deltas until the job completes.
  const timeoutMs = Number(process.env.ORBIT_PROVIDER_TIMEOUT_MS ?? 20 * 60 * 1000);
  const pollMs = Number(process.env.ORBIT_PROVIDER_POLL_MS ?? 700);
  const settleMs = Number(process.env.ORBIT_PROVIDER_SETTLE_MS ?? 2000);
  const started = Date.now();
  let hookOffset = 0;
  let doneFirstSeen: number | undefined;

  while (Date.now() - started < timeoutMs) {
    if (options?.signal?.aborted) {
      interruptPeer(session, agent);
      throw new Error("Request was aborted");
    }

    const page = readHookEvents(sent.id, { offset: hookOffset, home: DEFAULT_HOME });
    hookOffset = page.nextOffset;
    for (const event of page.events as any[]) {
      const line = formatHookProgress(event, agent);
      if (line) appendThinking(output, stream, `${line}\n`);
    }

    const job = refreshJob(getJob(sent.id, DEFAULT_HOME), DEFAULT_HOME);
    if (job.markerSeen) {
      return { text: providerResponse(job) };
    }
    if (job.doneFile) {
      doneFirstSeen ??= Date.now();
      if (Date.now() - doneFirstSeen >= settleMs) {
        return { text: providerResponse(job) };
      }
    }
    await sleep(pollMs);
    // Re-check abort immediately after the sleep to cut detection lag.
    if (options?.signal?.aborted) {
      interruptPeer(session, agent);
      throw new Error("Request was aborted");
    }
  }
  // M2: a timeout is an error, not a silent success. Throwing routes the stream
  // to { type: "error" } so callers can distinguish timeout from real output.
  interruptPeer(session, agent);
  throw new Error(`orbit provider job ${sent.id} timed out after ${timeoutMs}ms`);
}

/** Best-effort: interrupt the peer's in-flight turn so an abort/timeout does not
 * leave the agent running and burning resources. Never throws. */
function interruptPeer(session: string, agent: string) {
  try {
    const profile = getProfile(agent as any);
    sendKeys(session, profile.interruptKey);
  } catch {
    // Ignore: interrupt is best-effort.
  }
}

function providerResponse(job: any): string {
  const done = job.doneFile;
  if (typeof done?.final_response === "string" && done.final_response.trim()) {
    return truncate(done.final_response.trim(), 8000);
  }
  if (typeof done?.summary === "string" && done.summary.trim()) {
    return truncate(done.summary.trim(), 8000);
  }
  const tail = String(job.logTail || "").trim();
  if (tail) return truncate(tail, 4000);
  return `orbit provider job ${job.id} completed.`;
}

function buildProviderPrompt(context: Context, agent: string): string {
  const systemPrompt = truncate(context.systemPrompt || "", 6000);
  const messages = context.messages
    .slice(-12)
    .map((m) => formatMessageForPrompt(m as any))
    .join("\n\n");
  const toolsNote = context.tools?.length
    ? `Pi exposed ${context.tools.length} tools to its model. Use your own native tools (${agent} has full tool access here); do not emit raw JSON tool calls.`
    : "No tools were exposed for this request.";

  return [
    "You are serving as Pi's orbitals provider.",
    "This request is relayed into your interactive tmux session.",
    "Answer the latest user request. Use your own tools to inspect or edit files in this workspace if useful.",
    "When done, write the orbit done JSON with `final_response` set to exactly what Pi should show the user.",
    "",
    `<pi_system_prompt>\n${systemPrompt}\n</pi_system_prompt>`,
    "",
    `<pi_tools_note>\n${toolsNote}\n</pi_tools_note>`,
    "",
    `<pi_recent_messages>\n${messages}\n</pi_recent_messages>`,
  ].join("\n");
}

function formatMessageForPrompt(message: any): string {
  if (message.role === "assistant") {
    return `Assistant: ${formatAssistantContent(message.content)}`;
  }
  if (message.role === "toolResult") {
    return `Tool result (${message.toolName || "tool"}): ${truncate(formatContent(message.content), 6000)}`;
  }
  return `${capitalize(message.role || "message")}: ${truncate(formatContent(message.content), 8000)}`;
}

function formatAssistantContent(content: any): string {
  if (!Array.isArray(content)) return truncate(String(content ?? ""), 8000);
  return truncate(
    content
      .map((block: any) => {
        if (block.type === "text") return block.text;
        if (block.type === "thinking") return "[thinking omitted]";
        if (block.type === "toolCall")
          return `[tool call ${block.name} ${JSON.stringify(block.arguments ?? {})}]`;
        return `[${block.type || "content"}]`;
      })
      .join("\n"),
    8000,
  );
}

function formatContent(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((item: any) => {
      if (item.type === "text") return item.text;
      if (item.type === "image") return "[image]";
      return `[${item.type || "content"}]`;
    })
    .join("\n");
}

function formatHookProgress(event: any, agent: string): string | undefined {
  const label = agentLabel(agent);
  const name = event.hookEventName;
  const tool = event.toolName || "tool";
  if (name === "PreToolUse") return `${label} tool start: ${tool}${formatToolInput(event)}`;
  if (name === "PostToolUse") return `${label} tool done: ${tool}`;
  if (name === "PostToolUseFailure") return `${label} tool failed: ${tool}`;
  if (name === "SubagentStart") return `${label} subagent started`;
  if (name === "SubagentStop") return `${label} subagent stopped`;
  if (name === "Stop") return `${label} turn stopped`;
  return undefined;
}

function formatToolInput(event: any): string {
  const input = event.toolInput || {};
  const p = input.file_path || input.path;
  if (p) return ` (${p})`;
  if (event.toolName === "Bash" && input.command) return ` (${truncate(String(input.command), 120)})`;
  return "";
}

function agentLabel(agent: string): string {
  if (agent === "claude") return "Claude";
  if (agent === "codex") return "Codex";
  if (agent === "agy") return "Antigravity";
  return capitalize(agent);
}

// ---- stream helpers ----

function startText(output: AssistantMessage, stream: AssistantMessageEventStream) {
  output.content.push({ type: "text", text: "" });
  stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
}

function appendText(output: AssistantMessage, stream: AssistantMessageEventStream, text: string) {
  const idx = output.content.length - 1;
  const block = output.content[idx];
  if (block && block.type === "text") {
    block.text += text;
    stream.push({ type: "text_delta", contentIndex: idx, delta: text, partial: output });
  }
}

function appendThinking(output: AssistantMessage, stream: AssistantMessageEventStream, text: string) {
  if (!output.content.some((b) => b.type === "thinking")) {
    output.content.push({ type: "thinking", thinking: "" } as any);
    stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
  }
  const idx = output.content.findIndex((b) => b.type === "thinking");
  const block = output.content[idx] as any;
  block.thinking += text;
  stream.push({ type: "thinking_delta", contentIndex: idx, delta: text, partial: output });
}

function endThinking(output: AssistantMessage, stream: AssistantMessageEventStream) {
  const idx = output.content.findIndex((b) => b.type === "thinking");
  if (idx === -1) return;
  const block = output.content[idx] as any;
  stream.push({ type: "thinking_end", contentIndex: idx, content: block.thinking, partial: output });
}

// ---- misc ----

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 32) / 2);
  return `${text.slice(0, half)}\n[...truncated...]\n${text.slice(-half)}`;
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
