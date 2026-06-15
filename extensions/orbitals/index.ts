import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_HOME, listSessions, safeName } from "./state.ts";
import {
  captureSessionText,
  killOrbitSession,
  sendPrompt,
  startSession,
  steerSession,
} from "./jobs.ts";
import { knownAgents } from "./profiles.ts";

const AGENT_VALUES = knownAgents();

/** Build a typed text content block (literal "text" for AgentToolResult). */
function text(body: string): { type: "text"; text: string } {
  return { type: "text", text: body };
}

function toolError(error: unknown, details: Record<string, unknown>): AgentToolResult<unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [text(message ? `orbit error: ${message}` : "orbit error")],
    details: { ok: false, ...details },
  };
}

export default function orbitalsExtension(pi: ExtensionAPI): void {
  // Tool: orbit_start
  pi.registerTool({
    name: "orbit_start",
    label: "Start peer agent tmux session",
    description:
      "Start or reuse an interactive peer agent (claude, codex, or agy) in a durable tmux session. The peer runs on its subscription quota, not headless print mode. cwd is required so the peer can see project files.",
    parameters: Type.Object({
      agent: Type.Optional(
        Type.Union(
          AGENT_VALUES.map((a) => Type.Literal(a)),
          { description: "Peer agent. Defaults to ORBIT_DEFAULT_AGENT or claude." },
        ),
      ),
      name: Type.Optional(Type.String({ description: "Short session name. Defaults to cwd basename." })),
      cwd: Type.String({ description: "Working directory for the peer agent (required)." }),
      model: Type.Optional(Type.String({ description: "Model flag value for the agent." })),
      agentsMd: Type.Optional(
        Type.Boolean({
          description: "Auto-import AGENTS.md files. No-op for codex/agy (they read it natively). Default true.",
        }),
      ),
    }),
    async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
      try {
        const session = startSession({
          agent: params.agent,
          name: params.name,
          cwd: params.cwd,
          model: params.model,
          agentsMd: params.agentsMd,
        });
        return {
          content: [
            text(
              `${session.reused ? "Reused" : "Started"} ${session.agent} session ${session.name} (${session.tmuxSession}) in ${session.cwd}. Monitor: tmux attach -t ${session.tmuxSession}`,
            ),
          ],
          details: { session },
        };
      } catch (error) {
        return toolError(error, { agent: params.agent, name: params.name, cwd: params.cwd });
      }
    },
  });

  // Tool: orbit_send
  pi.registerTool({
    name: "orbit_send",
    label: "Send task to peer agent",
    description:
      "Send a task to a peer agent tmux session and optionally wait for completion. Returns a structured job result: status (sent/done/timeout/failed), markerSeen, doneFile, logTail, finalResponse. Completion floor is the agent idle TUI pattern; the marker only accelerates.",
    promptSnippet: "Delegate a task to an interactive peer agent (claude/codex/agy) in tmux",
    parameters: Type.Object({
      session: Type.Optional(Type.String({ description: "Session name. Defaults to default." })),
      prompt: Type.String({ description: "Task to send to the peer agent." }),
      wait: Type.Optional(Type.Boolean({ description: "Wait for completion (marker, done file, or idle). Default true." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Wait timeout in milliseconds." })),
      settleMs: Type.Optional(Type.Number({ description: "Settle window (ms) after done file appears." })),
    }),
    async execute(_toolCallId, params, _signal, onUpdate): Promise<AgentToolResult<unknown>> {
      try {
        onUpdate?.({ content: [text("Sending task to peer agent tmux session...")], details: {} });
        const result = await sendPrompt({
          session: params.session,
          prompt: params.prompt,
          wait: params.wait ?? true,
          timeoutMs: params.timeoutMs,
          settleMs: params.settleMs,
        });
        const summary = result.finalResponse ? `\nResponse: ${result.finalResponse}` : "";
        const failed = result.status === "timeout" || result.status === "failed";
        return {
          content: [
            text(
              `orbit job ${result.id} is ${result.status}. Marker seen: ${result.markerSeen}.${summary}\nSession: ${result.session}`,
            ),
          ],
          details: { job: result, ok: !failed },
        };
      } catch (error) {
        return toolError(error, { session: params.session });
      }
    },
  });

  // Tool: orbit_steer
  pi.registerTool({
    name: "orbit_steer",
    label: "Steer peer agent",
    description:
      "Send a live steering update to a running peer agent session. Refused if a job holds the session lock (wait for the active turn).",
    parameters: Type.Object({
      session: Type.Optional(Type.String({ description: "Session name. Defaults to default." })),
      message: Type.String({ description: "Steering message to paste into the peer agent." }),
    }),
    async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
      try {
        const result = steerSession({ session: params.session, message: params.message });
        return {
          content: [text(`Sent steering update to ${result.session} (${result.tmuxSession}).`)],
          details: result,
        };
      } catch (error) {
        return toolError(error, { session: params.session });
      }
    },
  });

  // Tool: orbit_status
  pi.registerTool({
    name: "orbit_status",
    label: "List orbit sessions",
    description: "List active pi-orbitals peer agent sessions.",
    parameters: Type.Object({}),
    async execute(): Promise<AgentToolResult<unknown>> {
      const sessions = listSessions();
      return {
        content: [
          text(
            sessions.length
              ? sessions.map((s) => `- ${s.name} [${s.agent}] ${s.tmuxSession} @ ${s.cwd}`).join("\n")
              : "No orbit sessions. Start one with orbit_start.",
          ),
        ],
        details: { sessions },
      };
    },
  });

  // Tool: orbit_capture
  pi.registerTool({
    name: "orbit_capture",
    label: "Capture peer agent terminal",
    description: "Capture recent terminal text from a peer agent tmux session. Use when a job times out or you need to inspect the live pane.",
    parameters: Type.Object({
      session: Type.Optional(Type.String({ description: "Session name. Defaults to default." })),
      lines: Type.Optional(Type.Number({ description: "Number of lines to capture. Default 120." })),
    }),
    async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
      try {
        const { session, text: paneText } = captureSessionText(safeName(params.session || "default"), {
          lines: params.lines,
        });
        return {
          content: [text(paneText || "(empty pane)")],
          details: { session: session.name, tmuxSession: session.tmuxSession },
        };
      } catch (error) {
        return toolError(error, { session: params.session });
      }
    },
  });

  // Tool: orbit_kill
  pi.registerTool({
    name: "orbit_kill",
    label: "Kill peer agent session",
    description: "Kill a peer agent tmux session and remove it from orbit state. Use to clean up orphaned or stuck sessions.",
    parameters: Type.Object({
      session: Type.Optional(Type.String({ description: "Session name. Defaults to default." })),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = killOrbitSession(safeName(params.session || "default"));
        return {
          content: [text(`Killed ${result.session.name} (${result.session.tmuxSession}).`)],
          details: { killed: result.killed, session: result.session.name },
        };
      } catch (error) {
        return toolError(error, { session: params.session });
      }
    },
  });
}

export { DEFAULT_HOME };
