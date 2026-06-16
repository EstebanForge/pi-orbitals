// Hook bridge: per-agent hook-config generators + event reader.
//
// The recorder lives in bin/orbit-hook.mjs (self-contained; agents invoke it as
// a `command` hook). This module generates the per-agent hook config that points
// each agent's lifecycle/tool events at the recorder, and reads the resulting
// canonical JSONL. It also exposes the package-relative recorder path.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHome, safeName, shellQuote } from "./state.ts";

/** Path to the standalone recorder, relative to the package root. */
export function recorderCommandPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // extensions/orbitals/hooks.ts -> ../../bin/orbit-hook.mjs
  return path.resolve(here, "..", "..", "bin", "orbit-hook.mjs");
}

/** Build the shell command an agent runs as a hook. */
export function buildRecorderCommand(options: { home: string; agent: string; recorderPath?: string }): string {
  const recorder = options.recorderPath || recorderCommandPath();
  // Env var MUST prefix the command: placed after the binary it becomes an
  // argv positional, never an env var, and process.env.ORBIT_HOOK_AGENT is unset.
  const command = [process.execPath, recorder, "--home", options.home]
    .map(shellQuote)
    .join(" ");
  return `ORBIT_HOOK_AGENT=${shellQuote(options.agent)} ${command}`;
}

/** Extract an orbit job id from arbitrary text (prompt, transcript). */
export function extractJobIdFromText(text: string): string | undefined {
  const match = String(text || "").match(/orbit job ([0-9a-fA-F-]{36})/i);
  return match?.[1];
}

// ---------------------------------------------------------------------------
// Per-agent hook config generators. Each writes a config file the agent loads
// at startup and returns its path (or the launch flag that points at it).
// ---------------------------------------------------------------------------

export interface HookConfigResult {
  /** Agent-specific: how startSession threads the config into the launch cmd. */
  kind: "claude-settings" | "codex-hooks" | "agy-hooks";
  configPath: string;
  /** Extra launch args (e.g. codex --dangerously-bypass-hook-trust). */
  extraLaunchArgs?: string[];
  /** For agy/codex, whether the config is project-local (.agents/) or user. */
  scope?: "project" | "user";
}

/** Build a Claude Code settings.json with command hooks for every event. */
export function buildClaudeHookSettings(options: {
  home: string;
  name: string;
  agent?: string;
  recorderPath?: string;
}): HookConfigResult {
  const dir = path.join(ensureHome(options.home), "hooks");
  mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, `${safeName(options.name)}.settings.json`);
  const command = buildRecorderCommand({
    home: options.home,
    agent: options.agent || "claude",
    recorderPath: options.recorderPath,
  });
  const hook = { type: "command", command, timeout: 5 };
  const toolHook = { matcher: "", hooks: [hook] };
  const turnHook = { hooks: [hook] };
  const settings = {
    hooks: {
      SessionStart: [turnHook],
      UserPromptSubmit: [turnHook],
      PreToolUse: [toolHook],
      PostToolUse: [toolHook],
      PostToolUseFailure: [toolHook],
      PostToolBatch: [turnHook],
      PermissionRequest: [toolHook],
      Notification: [turnHook],
      SubagentStart: [turnHook],
      SubagentStop: [turnHook],
      Stop: [turnHook],
      SessionEnd: [turnHook],
    },
  };
  writeFileSync(configPath, JSON.stringify(settings, null, 2));
  return { kind: "claude-settings", configPath };
}

/**
 * Build a Codex hooks.json. Codex loads ~/.codex/hooks.json (or project
 * .codex/hooks.json). Unattended use requires --dangerously-bypass-hook-trust
 * on launch (returned as extraLaunchArgs).
 */
export function buildCodexHooksConfig(options: {
  home: string;
  recorderPath?: string;
  scope?: "user" | "project";
  projectDir?: string;
}): HookConfigResult & { configPath: string } {
  const command = buildRecorderCommand({
    home: options.home,
    agent: "codex",
    recorderPath: options.recorderPath,
  });
  const hook = (matcher: string) => ({ matcher, hooks: [{ type: "command", command }] });
  const config = {
    hooks: {
      SessionStart: [hook("startup|resume")],
      UserPromptSubmit: [hook("")],
      PreToolUse: [hook("Bash|apply_patch|Edit|Write")],
      PostToolUse: [hook("Bash|apply_patch|Edit|Write")],
      Stop: [hook("")],
    },
  };
  const configPath =
    options.scope === "project" && options.projectDir
      ? path.join(options.projectDir, ".codex", "hooks.json")
      : path.join(os.homedir(), ".codex", "hooks.json");
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return {
    kind: "codex-hooks",
    configPath,
    extraLaunchArgs: ["--dangerously-bypass-hook-trust"],
    scope: options.scope === "project" ? "project" : "user",
  };
}

/**
 * Build an Antigravity (agy) hooks.json. agy loads .agents/hooks.json (project)
 * or ~/.gemini/config/hooks.json (user). Schema: named hook groups, each with an
 * event -> [{matcher?, hooks:[{command}]}].
 */
export function buildAgyHooksConfig(options: {
  home: string;
  scope?: "project" | "user";
  projectDir?: string;
  recorderPath?: string;
}): HookConfigResult {
  const command = buildRecorderCommand({
    home: options.home,
    agent: "agy",
    recorderPath: options.recorderPath,
  });
  const configPath =
    options.scope === "project" && options.projectDir
      ? path.join(options.projectDir, ".agents", "hooks.json")
      : path.join(os.homedir(), ".gemini", "config", "hooks.json");
  mkdirSync(path.dirname(configPath), { recursive: true });
  const config = {
    "orbit-recorder": {
      PreToolUse: [{ matcher: "run_command|write_to_file|replace_file_content", hooks: [{ type: "command", command }] }],
      PostToolUse: [{ matcher: "run_command|write_to_file|replace_file_content", hooks: [{ type: "command", command }] }],
      Stop: [{ hooks: [{ type: "command", command }] }],
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { kind: "agy-hooks", configPath, scope: options.scope === "project" ? "project" : "user" };
}

/** Dispatch to the right config generator for an agent. */
export function buildHookConfig(agent: string, options: {
  home: string;
  name: string;
  projectDir?: string;
  scope?: "project" | "user";
  recorderPath?: string;
}): HookConfigResult {
  switch (agent) {
    case "claude":
      return buildClaudeHookSettings(options);
    case "codex":
      return buildCodexHooksConfig({
        home: options.home,
        recorderPath: options.recorderPath,
        scope: options.scope,
        projectDir: options.projectDir,
      });
    case "agy":
      return buildAgyHooksConfig({
        home: options.home,
        recorderPath: options.recorderPath,
        scope: options.scope,
        projectDir: options.projectDir,
      });
    default:
      throw new Error(`No hook config for agent '${agent}'`);
  }
}

// ---------------------------------------------------------------------------
// Event reader (extension side): read the canonical JSONL the recorder writes.
// ---------------------------------------------------------------------------

export interface HookEventsPage {
  events: unknown[];
  nextOffset: number;
  file: string;
}

/** Read events/<jobId>.jsonl from a byte offset; return parsed events + next offset. */
export function readHookEvents(
  jobId: string,
  options: { offset?: number; home?: string } = {},
): HookEventsPage {
  const home = options.home ?? (process.env.ORBIT_HOME || path.join(os.homedir(), ".pi", "orbitals"));
  const offset = Number(options.offset ?? 0);
  const file = path.join(ensureHome(home), "events", `${jobId}.jsonl`);
  if (!existsSync(file)) return { events: [], nextOffset: offset, file };
  const content = readFileSync(file, "utf8");
  const slice = content.slice(offset);
  const events: unknown[] = [];
  for (const line of slice.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }
  return { events, nextOffset: content.length, file };
}

export {};
