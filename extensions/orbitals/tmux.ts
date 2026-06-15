import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { sleepSync, shellQuote, stripAnsi, OrbitError } from "./state.ts";

/** Default pane geometry. TUIs (claude/codex/agy) wrap or invoke pagers below this. */
export const PANE_WIDTH = Number(process.env.ORBIT_PANE_WIDTH || 120);
export const PANE_HEIGHT = Number(process.env.ORBIT_PANE_HEIGHT || 40);

export interface TmuxResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run tmux with args. Throws OrbitError on non-zero unless allowFailure. */
export function tmux(
  args: string[],
  options: { allowFailure?: boolean; cwd?: string } = {},
): TmuxResult {
  const result = spawnSync("tmux", args, {
    encoding: "utf8",
    cwd: options.cwd,
  });
  if (result.error) {
    throw new OrbitError(`Failed to run tmux: ${result.error.message}`, { args });
  }
  if (options.allowFailure) return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  if (result.status !== 0) {
    throw new OrbitError(
      `tmux ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
      { args, status: result.status, stdout: result.stdout, stderr: result.stderr },
    );
  }
  return { status: result.status ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Verify tmux is installed. */
export function assertTmuxAvailable(): string {
  const result = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new OrbitError("tmux is required but was not found on PATH");
  }
  return (result.stdout || "").trim();
}

/** True if a tmux session exists. */
export function sessionExists(tmuxSession: string): boolean {
  return tmux(["has-session", "-t", tmuxSession], { allowFailure: true }).status === 0;
}

/** Start a detached tmux session running `command`, sized PANE_WIDTH x PANE_HEIGHT, in cwd. */
export function startTmuxSession(
  tmuxSession: string,
  cwd: string,
  command: string,
  options: { width?: number; height?: number } = {},
): void {
  const width = options.width ?? PANE_WIDTH;
  const height = options.height ?? PANE_HEIGHT;
  // -x/-y set the initial window size for the detached session.
  tmux([
    "new-session",
    "-d",
    "-s",
    tmuxSession,
    "-x",
    String(width),
    "-y",
    String(height),
    "-c",
    cwd,
    command,
  ]);
}

/** Pipe the session pane to an append-only log file. */
export function pipePane(tmuxSession: string, logPath: string): void {
  tmux(["pipe-pane", "-o", "-t", tmuxSession, `cat >> ${shellQuote(logPath)}`]);
}

/** Clear the pane's scrollback history. Avoids stale marker matches. */
export function clearHistory(tmuxSession: string): void {
  // tmux-level only; do NOT send C-l (agents' TUIs intercept it and it does
  // not clear scrollback anyway). clear-history wipes the saved pane history.
  tmux(["clear-history", "-t", tmuxSession], { allowFailure: true });
}

export function killSession(tmuxSession: string): boolean {
  return tmux(["kill-session", "-t", tmuxSession], { allowFailure: true }).status === 0;
}

/** Capture recent pane text (joined lines, N history lines back). */
export function capturePane(
  tmuxSession: string,
  options: { lines?: number; target?: string } = {},
): string {
  const lines = Math.abs(options.lines ?? 120);
  const target = options.target ?? tmuxSession;
  const result = tmux(
    ["capture-pane", "-p", "-J", "-S", String(-lines), "-t", target],
    { allowFailure: true },
  );
  return result.stdout ?? "";
}

/** Get the visible (stripped) pane text for pattern matching. */
export function capturePaneClean(
  tmuxSession: string,
  options: { lines?: number } = {},
): string {
  return stripAnsi(capturePane(tmuxSession, options));
}

export interface PasteResult {
  ok: boolean;
  attempts: number;
}

/**
 * Paste a prompt file into the session and submit it.
 *
 * Uses bracketed paste (`-p`) + submit (`C-m`). No pre-submit visibility check:
 * Claude Code collapses bracketed pastes into a `[Pasted text #N]` chip, so the
 * literal prompt text is not visible in the pane and a signature check would
 * always fail. The paste reliably delivers content (the chip proves it);
 * completion reliability comes from waitForJob (idle/marker/done-file), which
 * catches a genuinely dropped paste via timeout. An optional small settle delay
 * lets slower TUIs (codex) ingest the paste before submit.
 */
export function pastePromptFile(
  tmuxSession: string,
  promptPath: string,
  _signature: string,
  options: { settleMs?: number } = {},
): PasteResult {
  const bufferName = `orbit-${path.basename(promptPath, ".txt")}`;
  const promptBytes = statSync(promptPath).size;
  const settleMs = options.settleMs ?? Math.min(3000, Math.max(300, Math.ceil(promptBytes / 8)));
  tmux(["load-buffer", "-b", bufferName, promptPath]);
  try {
    tmux(["paste-buffer", "-p", "-r", "-b", bufferName, "-t", tmuxSession]);
    sleepSync(settleMs);
    tmux(["send-keys", "-t", tmuxSession, "C-m"]);
    return { ok: true, attempts: 1 };
  } finally {
    tmux(["delete-buffer", "-b", bufferName], { allowFailure: true });
  }
}

/** Send a raw keystroke (C-c, C-d, Escape, etc.). */
export function sendKeys(tmuxSession: string, key: string): void {
  tmux(["send-keys", "-t", tmuxSession, key]);
}
