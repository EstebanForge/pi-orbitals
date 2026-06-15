import { shellQuote } from "./state.ts";

export type AgentId = "claude" | "codex" | "agy";

export type AgentsMdMode = "inject" | "native";

export interface LaunchOptions {
  model: string;
  /** Path to a combined AGENTS.md prompt file (only used when agentsMd === "inject"). */
  agentsPromptPath?: string;
  /** Extra raw args to append after the built ones. */
  extraArgs?: string[];
}

export interface AgentProfile {
  id: AgentId;
  /** Build the shell command the peer runs as. cwd is applied by tmux, not here. */
  launch: (opts: LaunchOptions) => string;
  /** Whether this agent reads AGENTS.md natively or needs injection. */
  agentsMd: AgentsMdMode;
  /**
   * Idle / input-ready pattern. The TRUE completion floor: when this matches
   * the pane text, the agent is waiting for input and the turn is done, even
   * if the ORBIT_DONE marker was never emitted.
   */
  idlePattern: RegExp;
  /** First-run trust prompt pattern (auto-answered by pressing Enter). */
  trustPattern: RegExp;
  /** Keystroke to interrupt the current turn. */
  interruptKey: string;
}

/** Default model flag value for an agent, from state defaults. */
export function defaultModel(id: AgentId): string {
  const map: Record<AgentId, string> = {
    claude: process.env.ORBIT_CLAUDE_MODEL || "opus",
    codex: process.env.ORBIT_CODEX_MODEL || "gpt-5.1",
    agy: process.env.ORBIT_AGY_MODEL || "gemini-2.5-pro",
  };
  return map[id];
}

const CLAUDE_PROFILE: AgentProfile = {
  id: "claude",
  agentsMd: "inject",
  // claude reads CLAUDE.md natively; AGENTS.md is injected via the file flag.
  launch: (opts) => {
    const argv = ["claude", "--model", opts.model, "--dangerously-skip-permissions"];
    if (opts.agentsPromptPath) argv.push("--append-system-prompt-file", opts.agentsPromptPath);
    if (opts.extraArgs) argv.push(...opts.extraArgs);
    return argv.map(shellQuote).join(" ");
  },
  // Claude Code input-ready prompt and mode indicators.
  idlePattern: /❯\s*$|(?:bypass permissions|accept edits|plan mode) (?:is )?on/i,
  // Claude workspace trust prompt.
  trustPattern: /Yes, I trust this folder|Enter to confirm|Quick safety check/i,
  interruptKey: "Escape",
};

const CODEX_PROFILE: AgentProfile = {
  id: "codex",
  agentsMd: "native",
  launch: (opts) => {
    const argv = [
      "codex",
      "-m",
      opts.model,
      "--dangerously-bypass-approvals-and-sandbox",
    ];
    if (opts.extraArgs) argv.push(...opts.extraArgs);
    return argv.map(shellQuote).join(" ");
  },
  // codex TUI prompt. Verified against installed build; refine in smoke.
  idlePattern: />\s*$|waiting for input|what next/i,
  trustPattern: /trust this (project|folder)|yes,? i (do|trust)/i,
  interruptKey: "C-c",
};

const AGY_PROFILE: AgentProfile = {
  id: "agy",
  agentsMd: "native",
  launch: (opts) => {
    const argv = ["agy", "-i", "--model", opts.model, "--dangerously-skip-permissions"];
    if (opts.extraArgs) argv.push(...opts.extraArgs);
    return argv.map(shellQuote).join(" ");
  },
  // agy (Antigravity) prompt. Refine in smoke.
  idlePattern: />\s*$|ready for input/i,
  trustPattern: /trust this (workspace|folder)|yes,? i (do|trust)/i,
  interruptKey: "C-c",
};

const PROFILES: Record<AgentId, AgentProfile> = {
  claude: CLAUDE_PROFILE,
  codex: CODEX_PROFILE,
  agy: AGY_PROFILE,
};

export function getProfile(id: string): AgentProfile {
  const profile = PROFILES[id as AgentId];
  if (!profile) {
    throw new Error(
      `Unknown agent '${id}'. Known agents: ${Object.keys(PROFILES).join(", ")}.`,
    );
  }
  return profile;
}

export function knownAgents(): AgentId[] {
  return Object.keys(PROFILES) as AgentId[];
}
