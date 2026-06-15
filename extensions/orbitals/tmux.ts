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

/** Clear the pane and its scrollback history (avoids stale marker matches). */
export function clearHistory(tmuxSession: string): void {
  tmux(["send-keys", "-t", tmuxSession, "C-l"], { allowFailure: true });
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
 * Paste a prompt file into the session with bracketed paste, verify it is
 * visible (by the injected `orbit job <signature>` line), retry (line-kill
 * with C-u) if tmux drops it, then submit with C-m.
 * Mirrors ccmux's paste-buffer reliability. `signature` is the job id, which
 * buildPrompt always injects as `orbit job <id>`, so it is a reliable presence
 * check.
 */
export function pastePromptFile(
  tmuxSession: string,
  promptPath: string,
  signature: string,
  options: { maxAttempts?: number; pasteDelayMs?: number } = {},
): PasteResult {
  const bufferName = `orbit-${path.basename(promptPath, ".txt")}`;
  tmux(["load-buffer", "-b", bufferName, promptPath]);
  const promptBytes = statSync(promptPath).size;
  const defaultDelay = Math.min(5000, Math.max(500, Math.ceil(promptBytes / 4)));
  const pasteDelayMs = options.pasteDelayMs ?? defaultDelay;
  const maxAttempts = options.maxAttempts ?? 3;
  const needle = new RegExp(`orbit job ${escapeForRegExp(signature)}`, "i");
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    // -p bracketed paste, -r no newline conversion, -b named buffer.
    tmux(["paste-buffer", "-p", "-r", "-b", bufferName, "-t", tmuxSession]);
    sleepSync(pasteDelayMs);
    const visible = capturePaneClean(tmuxSession, { lines: 120 });
    if (needle.test(visible)) {
      tmux(["delete-buffer", "-b", bufferName], { allowFailure: true });
      tmux(["send-keys", "-t", tmuxSession, "C-m"]);
      return { ok: true, attempts };
    }
    if (attempt < maxAttempts) {
      tmux(["send-keys", "-t", tmuxSession, "C-u"]);
      sleepSync(500);
    }
  }
  tmux(["delete-buffer", "-b", bufferName], { allowFailure: true });
  throw new OrbitError(
    `Pasted prompt was not visible in tmux pane after ${attempts} attempt(s)`,
    { tmuxSession, promptPath, signature },
  );
}

function escapeForRegExp(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Send a raw keystroke (C-c, C-d, Escape, etc.). */
export function sendKeys(tmuxSession: string, key: string): void {
  tmux(["send-keys", "-t", tmuxSession, key]);
}
