import { shellQuote } from "./state.ts";

export type AgentId = "claude" | "codex" | "agy";

export type AgentsMdMode = "inject" | "native";

export interface LaunchOptions {
  model: string;
  /** Path to a combined AGENTS.md prompt file (only used when agentsMd === "inject"). */
  agentsPromptPath?: string;
  /** Path to a Claude Code settings.json (hooks). Passed via --settings. */
  settingsPath?: string;
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
  /**
   * Answer an interactive dialog that appears AFTER the prompt is pasted (mid-turn),
   * e.g. codex rate-limit model-switch or agy command-approval. Receives recent pane
   * text and a send(keys) callback; return true if a dialog was answered (caller
   * settles before re-checking completion).
   */
  handleMidTurnDialog?: (text: string, send: (keys: string) => void) => boolean;
}

/** Default model flag value for an agent, from state defaults. */
export function defaultModel(id: AgentId): string {
  const map: Record<AgentId, string> = {
    claude: process.env.ORBIT_CLAUDE_MODEL || "opus",
    codex: process.env.ORBIT_CODEX_MODEL || "gpt-5.1",
    agy: process.env.ORBIT_AGY_MODEL || "Gemini 3.5 Flash (Low)",
  };
  return map[id];
}

// CLAUDE smoke (2026-06-15, Sonnet 4.6):
//   trust prompt on first run -> press Enter (❯ pre-selects "Yes, I trust this folder").
//   idle: input box "❯ " + footer "bypass permissions on".
const CLAUDE_PROFILE: AgentProfile = {
  id: "claude",
  agentsMd: "inject",
  // claude reads CLAUDE.md natively; AGENTS.md is injected via the file flag.
  launch: (opts) => {
    const argv = ["claude", "--model", opts.model, "--dangerously-skip-permissions"];
    if (opts.agentsPromptPath) argv.push("--append-system-prompt-file", opts.agentsPromptPath);
    if (opts.settingsPath) argv.push("--settings", opts.settingsPath);
    if (opts.extraArgs) argv.push(...opts.extraArgs);
    return argv.map(shellQuote).join(" ");
  },
  // Claude Code input-ready prompt and mode indicators.
  idlePattern: /❯\s*$|(?:bypass permissions|accept edits|plan mode) (?:is )?on/i,
  // Claude workspace trust prompt.
  trustPattern: /Yes, I trust this folder|Enter to confirm|Quick safety check/i,
  interruptKey: "Escape",
};

// CODEX smoke (2026-06-15, gpt-5.1, codex-cli 0.139.0):
//   blank screen until the TUI paints (slow startup / needs a moment); wait for the
//   status footer "<model> low · <cwd>" before pasting, else input is swallowed.
//   "permissions: YOLO mode" confirms --dangerously-bypass-approvals-and-sandbox works.
//   rate-limit / model-switch dialogs appear as interactive prompts (Enter/Esc).
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
  // codex TUI: input prompt "›" and status footer "<model> low · <cwd>".
  idlePattern: /›\s*$|gpt-[0-9.]+ .*· .+\//i,
  // codex trust-this-directory + rate-limit / model-switch dialogs. 0.139.0 shows
  // "Do you trust the contents of this directory? ... Press enter to continue";
  // all are confirm-with-Enter (option 1 pre-selected).
  trustPattern: /Do you trust the contents of this directory|Yes,? continue|Press enter to continue|Press enter to confirm or esc to go back|Switch to .+ for lower credit/i,
  interruptKey: "C-c",
  // Mid-turn: codex "Approaching rate limits / Switch to <model> for lower credit"
  // dialog (appears post-paste). Confirm option 1 (Switch to the lower-cost model).
  handleMidTurnDialog: (text, send) => {
    if (/Switch to .+ for lower credit|Approaching rate limits/i.test(text)) {
      send("C-m");
      return true;
    }
    return false;
  },
};

// AGY smoke (2026-06-15, Gemini 3.5 Flash Low):
//   IMPORTANT: agy auto-runs the AGENTS.md workflow on startup (e.g. mcp-cli-ent)
//   instead of sitting idle. Escape interrupts the autonomous turn -> idle input ">".
//   --dangerously-skip-permissions does NOT suppress command-approval prompts.
const AGY_PROFILE: AgentProfile = {
  id: "agy",
  agentsMd: "native",
  launch: (opts) => {
    const argv = ["agy", "-i", "--model", opts.model, "--dangerously-skip-permissions"];
    if (opts.extraArgs) argv.push(...opts.extraArgs);
    return argv.map(shellQuote).join(" ");
  },
  // agy (Antigravity) idle input prompt ">" with "? for shortcuts" footer.
  idlePattern: />\s*$|\? for shortcuts/i,
  // agy command-approval / trust dialogs.
  trustPattern: /Do you want to proceed\?|trust this (workspace|folder)|yes,? i (do|trust)/i,
  interruptKey: "Escape",
  // Mid-turn: agy command-approval "Do you want to proceed?". Option 2 =
  // "Yes, and always allow in this conversation" -> completes the turn without
  // re-prompting for that command, and (unlike option 3) does NOT persist to the
  // user's global settings.json. Consistent with the bypass-flag security model.
  handleMidTurnDialog: (text, send) => {
    if (/Do you want to proceed\?/i.test(text)) {
      send("2");
      send("C-m");
      return true;
    }
    return false;
  },
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
