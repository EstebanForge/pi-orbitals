import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_HOME,
  DEFAULT_MODELS,
  OrbitError,
  acquireSessionLock,
  ensureHome,
  escapeRegExp,
  expandHome,
  getJob,
  getSession,
  loadState,
  safeName,
  saveState,
  sleepSync,
  stripAnsi,
  readTail,
} from "./state.ts";
import type { JobRecord, JobStatus, SessionRecord } from "./state.ts";
import {
  clearHistory,
  killSession,
  pastePromptFile,
  pipePane,
  sessionExists,
  startTmuxSession,
  assertTmuxAvailable,
  capturePaneClean,
  sendKeys,
} from "./tmux.ts";
import { getProfile, defaultModel } from "./profiles.ts";
import type { LaunchOptions } from "./profiles.ts";
import type { AgentProfile } from "./profiles.ts";
import { buildHookConfig } from "./hooks.ts";

export { getSession, getJob };

export interface StartOptions {
  agent?: string;
  name?: string;
  cwd: string;
  model?: string;
  home?: string;
  extraArgs?: string[];
  /** Auto-import AGENTS.md files (default true; no-op for native agents). */
  agentsMd?: boolean;
  /**
   * Enable the orbit hook recorder for structured lifecycle/tool events. Default
   * per agent: claude true (per-session --settings, isolated), codex/agy false
   * (project-local config files have repo side-effects; opt in).
   */
  hooks?: boolean;
  /** Scope for codex/agy hook config: "project" (default) writes into cwd, "user" writes to ~/. */
  hookScope?: "project" | "user";
}

export interface SendOptions {
  session?: string;
  prompt: string;
  wait?: boolean;
  timeoutMs?: number;
  settleMs?: number;
  home?: string;
}

export interface SendResult {
  id: string;
  status: JobStatus;
  markerSeen: boolean;
  doneFile: Record<string, unknown> | null;
  logTail: string;
  finalResponse: string | null;
  session: string;
}

/** Walk cwd up to home, collecting AGENTS.md files (parent-first). */
export function discoverAgentsMd(cwd: string): string[] {
  const start = path.resolve(expandHome(cwd) || process.cwd());
  const home = os.homedir();
  const files: string[] = [];
  let current = start;
  let depth = 0;
  while (true) {
    const candidate = path.join(current, "AGENTS.md");
    if (existsSync(candidate)) files.push(candidate);
    const parent = path.dirname(current);
    // Stop at filesystem root, home, or a sane depth cap (stray AGENTS.md under
    // system paths when the project lives outside home).
    if (current === parent || current === home || ++depth > 20) break;
    current = parent;
  }
  return files.reverse();
}

/** Build a combined AGENTS.md prompt file for agents that need injection. */
function prepareAgentsContext(opts: {
  cwd: string;
  name: string;
  home: string;
}): { files: string[]; promptPath?: string } {
  const files = discoverAgentsMd(opts.cwd);
  if (files.length === 0) return { files };
  const dir = path.join(ensureHome(opts.home), "instructions");
  mkdirSync(dir, { recursive: true });
  const promptPath = path.join(dir, `${safeName(opts.name)}.agents.md`);
  const content = [
    "# AGENTS.md instructions imported by pi-orbitals",
    "",
    ...files.flatMap((file) => [`## ${file}`, "", readFileSync(file, "utf8"), ""]),
  ].join("\n");
  writeFileSync(promptPath, content);
  return { files, promptPath };
}

/** Start (or reuse) an interactive peer agent session in tmux. */
export function startSession(options: StartOptions): SessionRecord {
  assertTmuxAvailable();
  const home = ensureHome(options.home);
  const agentId = options.agent || process.env.ORBIT_DEFAULT_AGENT || "claude";
  const profile = getProfile(agentId);
  const name = safeName(options.name || path.basename(path.resolve(options.cwd)));
  const cwd = path.resolve(expandHome(options.cwd));
  const tmuxSession = `orbit-${name}`;
  const logPath = path.join(home, "logs", `${name}.ansi.log`);
  const model = options.model || defaultModel(profile.id as never) || DEFAULT_MODELS[agentId] || "opus";

  const agentsContext =
    options.agentsMd === false || profile.agentsMd === "native"
      ? { files: [] as string[] }
      : prepareAgentsContext({ cwd, name, home });

  // Hook recorder config (structured events). Default per agent; opt-out via
  // hooks:false. claude uses an isolated per-session settings.json; codex/agy
  // write project-local config files (repo side-effect) unless scope is "user".
  const hooksEnabled = options.hooks ?? (profile.id === "claude");
  let hookConfigPath: string | undefined;
  const launchExtraArgs = [...(options.extraArgs ?? [])];
  if (hooksEnabled) {
    const hook = buildHookConfig(profile.id, {
      home,
      name,
      projectDir: cwd,
      scope: options.hookScope ?? "project",
    });
    hookConfigPath = hook.configPath;
    if (hook.extraLaunchArgs) launchExtraArgs.push(...hook.extraLaunchArgs);
  }

  const launchOpts: LaunchOptions = {
    model,
    agentsPromptPath: agentsContext.promptPath,
    settingsPath: profile.id === "claude" ? hookConfigPath : undefined,
    extraArgs: launchExtraArgs.length ? launchExtraArgs : undefined,
  };
  const command = profile.launch(launchOpts);

  const state = loadState(home);
  const reused = sessionExists(tmuxSession);

  if (!reused) {
    startTmuxSession(tmuxSession, cwd, command);
  }
  pipePane(tmuxSession, logPath);

  // Groom the freshly launched (or reused) session to a clean input-ready
  // state before returning: accept claude trust prompts, dismiss codex
  // rate-limit dialogs, interrupt agy autonomous startup. Best-effort; a
  // timeout here is non-fatal (sendJob re-grooms before pasting).
  prepareSessionForInput(profile, tmuxSession, {
    timeoutMs: Number(process.env.ORBIT_READY_TIMEOUT_MS ?? 45_000),
  });

  const now = new Date().toISOString();
  const record: SessionRecord = {
    name,
    agent: profile.id,
    tmuxSession,
    cwd,
    command,
    logPath,
    createdAt: state.sessions[name]?.createdAt ?? now,
    updatedAt: now,
    model,
    reused,
    hooksEnabled,
    hookConfigPath,
  };
  state.sessions[name] = record;
  saveState(state, home);
  return record;
}

export function killOrbitSession(name: string, home: string = DEFAULT_HOME): { killed: boolean; session: SessionRecord } {
  const session = getSession(name, home);
  const killed = killSession(session.tmuxSession);
  const state = loadState(home);
  delete state.sessions[session.name];
  saveState(state, home);
  return { killed, session };
}

/**
 * Groom a peer agent pane to a clean input-ready state before pasting a prompt.
 * Per-agent handling, derived from real smoke captures (2026-06-15):
 *  - any dialog with a pre-selected confirm option + "enter to confirm" -> C-m
 *  - any "esc to go back" / rate-limit model-switch dialog -> Escape (dismiss)
 *  - agy runs the AGENTS.md workflow on startup; if non-idle with no dialog,
 *    send Escape once to interrupt the autonomous turn.
 * Returns when the profile idlePattern matches, or throws on timeout.
 * Best-effort: a leftover dialog is non-fatal because sendJob re-runs this.
 */
export function prepareSessionForInput(
  profile: AgentProfile,
  tmuxSession: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): { ready: boolean; acceptedDialogs: number; interrupted: boolean } {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const pollMs = options.pollMs ?? 800;
  const started = Date.now();
  let acceptedDialogs = 0;
  let interrupted = false;

  while (Date.now() - started < timeoutMs) {
    if (!sessionExists(tmuxSession)) {
      throw new OrbitError(`tmux session ${tmuxSession} died during readiness check`);
    }
    const text = capturePaneClean(tmuxSession, { lines: 160 });

    // 1. Trust / approval dialog with a pre-selected Yes -> confirm with Enter.
    if (profile.trustPattern.test(text)) {
      sendKeys(tmuxSession, "C-m");
      acceptedDialogs += 1;
      sleepSync(2500);
      continue;
    }
    // 2. Dismissable rate-limit / model-switch dialog ("esc to go back").
    if (/esc to go back|esc to cancel/i.test(text)) {
      sendKeys(tmuxSession, "Escape");
      sleepSync(1500);
      continue;
    }
    // 3. Idle input-ready -> done.
    if (profile.idlePattern.test(text)) {
      return { ready: true, acceptedDialogs, interrupted };
    }
    // 4. agy autonomous startup (non-idle, no dialog) -> interrupt once.
    if (profile.id === "agy" && !interrupted) {
      sendKeys(tmuxSession, "Escape");
      interrupted = true;
      sleepSync(2000);
      continue;
    }
    sleepSync(pollMs);
  }
  return { ready: false, acceptedDialogs, interrupted };
}

/** Build the prompt body with the completion protocol appended. */
export function buildPrompt(opts: {
  task: string;
  id: string;
  donePath: string;
  protocol?: boolean;
}): string {
  const body = String(opts.task || "").trim();
  if (opts.protocol === false) return body;
  const marker = `ORBIT_DONE:${opts.id}`;
  // Lead with a first-line signature `orbit job <id>`: this is what the TUI
  // input box displays on its first line, so pastePromptFile's visibility
  // check (which looks at the visible pane) can confirm the paste landed.
  // extractJobIdFromText also keys off this line for hook job-id binding.
  return [
    `orbit job ${opts.id}`,
    body,
    "",
    "<orbit_completion_protocol>",
    "Do your work, then finish.",
    `When fully done, include one completion marker line in your final response: ${marker}`,
    "Do not add spaces, quotes, or punctuation to the marker line.",
    `If you used tools or changed files, also create this JSON file before the final response: ${opts.donePath}`,
    "The JSON may contain status, summary, final_response, files_changed, and notes.",
    "</orbit_completion_protocol>",
  ].join("\n");
}

/** Create a job record and write its prompt file. */
export function makeJob(opts: {
  session: string;
  prompt: string;
  home?: string;
  protocol?: boolean;
}): { job: JobRecord; promptText: string } {
  const home = ensureHome(opts.home);
  const session = getSession(opts.session || "default", home);
  if (!sessionExists(session.tmuxSession)) {
    throw new OrbitError(`tmux session ${session.tmuxSession} is not running`);
  }
  const id = randomUUID();
  const promptPath = path.join(home, "jobs", `${id}.prompt.txt`);
  // Done files live under ORBIT_HOME (not the project cwd) so peer turns do not
  // pollute the user's repo with an untracked .orbit/ directory.
  const doneRoot = path.join(home, "jobs");
  mkdirSync(doneRoot, { recursive: true });
  const donePath = path.join(doneRoot, `${id}.done.json`);
  const promptText = buildPrompt({
    task: opts.prompt,
    id,
    donePath,
    protocol: opts.protocol !== false,
  });
  writeFileSync(promptPath, promptText);

  const now = new Date().toISOString();
  const job: JobRecord = {
    id,
    marker: `ORBIT_DONE:${id}`,
    agent: session.agent,
    session: session.name,
    tmuxSession: session.tmuxSession,
    cwd: session.cwd,
    promptPath,
    donePath,
    logPath: session.logPath,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  const state = loadState(home);
  state.jobs[id] = job;
  state.sessions[session.name] = { ...session, updatedAt: now };
  saveState(state, home);
  return { job, promptText };
}

function readDoneFile(file: string): Record<string, unknown> | null {
  if (!file || !existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { raw: readFileSync(file, "utf8") };
  }
}

/** Refresh a job's runtime status from log tail + done file + pane liveness. */
export function refreshJob(job: JobRecord, home: string = DEFAULT_HOME): JobRecord & {
  doneFile: Record<string, unknown> | null;
  markerSeen: boolean;
  logTail: string;
  idle: boolean;
} {
  const profile = getProfile(job.agent);
  const tail = readTail(job.logPath, 256 * 1024);
  const cleanTail = stripAnsi(tail);
  // Require the marker on its own line. The prompt instructions contain the
  // literal `ORBIT_DONE:<id>` mid-line ("...response: ORBIT_DONE:<id>"); a
  // cold-start raw paste can echo that into the pane. Anchoring to line start
  // (the agent emits the marker standalone per the protocol) avoids false
  // positives while still matching real completion.
  const markerPattern = new RegExp(`(^|\\n)ORBIT_DONE:\\s*${escapeRegExp(job.id)}(\\r?\\n|$)`);
  const markerSeen = markerPattern.test(cleanTail);
  const doneFile = readDoneFile(job.donePath);
  const paneText = stripAnsi(readTail(job.logPath, 8 * 1024));
  const idle = profile.idlePattern.test(paneText);
  const alive = sessionExists(job.tmuxSession);
  let status: JobStatus = job.status;
  if (!alive && status !== "done") status = "failed";
  else if (doneFile || markerSeen) status = "done";
  else if (idle && status === "sent") status = "done";
  return { ...job, status, doneFile, markerSeen, logTail: cleanTail.slice(-8000), idle };
}

/** Paste a job's prompt into its session. Caller owns the session lock. */
export function sendJob(
  job: JobRecord,
  home: string = DEFAULT_HOME,
): JobRecord {
  // Re-groom the pane to idle before pasting: clears any leftover trust,
  // rate-limit, or autonomous-startup state from a prior turn.
  const profile = getProfile(job.agent);
  prepareSessionForInput(profile, job.tmuxSession, {
    timeoutMs: Number(process.env.ORBIT_READY_TIMEOUT_MS ?? 45_000),
  });
  clearHistory(job.tmuxSession);
  pastePromptFile(job.tmuxSession, job.promptPath, job.id);
  const now = new Date().toISOString();
  const state = loadState(home);
  state.jobs[job.id] = { ...job, status: "sent", sentAt: now, updatedAt: now };
  saveState(state, home);
  return state.jobs[job.id];
}

/**
 * Wait for a sent job to complete. Completion floor order:
 *   marker OR done-file OR idle TUI pattern (per agent profile).
 * Crashes detected via hasSession -> failed status.
 */
export async function waitForJob(
  id: string,
  options: { timeoutMs?: number; settleMs?: number; home?: string; pollMs?: number } = {},
): Promise<SendResult> {
  const home = options.home ?? DEFAULT_HOME;
  const timeoutMs = options.timeoutMs ?? Number(process.env.ORBIT_WAIT_TIMEOUT_MS ?? 600_000);
  const settleMs = options.settleMs ?? Number(process.env.ORBIT_SETTLE_MS ?? 3000);
  const pollMs = options.pollMs ?? 1000;
  const started = Date.now();
  let doneFileFirstSeenAt: number | null = null;

  while (Date.now() - started < timeoutMs) {
    const job = refreshJob(getJob(id, home), home);
    if (job.status === "failed") {
      updateJobStatus(id, "failed", home);
      return toResult(job);
    }
    if (job.markerSeen) {
      updateJobStatus(id, "done", home);
      return toResult(refreshJob(getJob(id, home), home));
    }
    if (job.doneFile) {
      doneFileFirstSeenAt ??= Date.now();
      if (Date.now() - doneFileFirstSeenAt >= settleMs) {
        updateJobStatus(id, "done", home);
        return toResult(refreshJob(getJob(id, home), home));
      }
    } else if (job.idle) {
      // Idle pattern is the floor: agent is waiting for input = turn done.
      updateJobStatus(id, "done", home);
      return toResult(refreshJob(getJob(id, home), home));
    }
    await sleepAsync(pollMs);
  }
  updateJobStatus(id, "timeout", home);
  return toResult(refreshJob(getJob(id, home), home));
}

function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateJobStatus(id: string, status: JobStatus, home: string = DEFAULT_HOME): void {
  const state = loadState(home);
  if (state.jobs[id]) {
    state.jobs[id].status = status;
    state.jobs[id].updatedAt = new Date().toISOString();
    saveState(state, home);
  }
}

function toResult(job: ReturnType<typeof refreshJob>): SendResult {
  const doneFile = job.doneFile;
  const finalResponse =
    (typeof doneFile?.final_response === "string" && doneFile.final_response) ||
    (typeof doneFile?.summary === "string" && doneFile.summary) ||
    null;
  return {
    id: job.id,
    status: job.status,
    markerSeen: job.markerSeen,
    doneFile,
    logTail: job.logTail,
    finalResponse: finalResponse?.trim() || null,
    session: job.session,
  };
}

/**
 * Send a prompt end-to-end: make job, acquire session lock, paste, optionally
 * wait, release lock. The lock is held across the whole turn so concurrent
 * sends/steers to one pane queue rather than collide. Non-wait sends release
 * immediately after paste (caller accepts the documented race).
 */
export async function sendPrompt(options: SendOptions): Promise<SendResult> {
  const home = options.home ?? DEFAULT_HOME;
  const sessionName = options.session || "default";
  const { job } = makeJob({ session: sessionName, prompt: options.prompt, home });
  const release = acquireSessionLock(sessionName, home);
  try {
    sendJob(job, home);
    if (!options.wait) {
      return toResult(refreshJob(job, home));
    }
    return await waitForJob(job.id, {
      timeoutMs: options.timeoutMs,
      settleMs: options.settleMs,
      home,
    });
  } finally {
    release();
  }
}

/** Steer a running session with a mid-turn message. Refused if a job holds the lock. */
export function steerSession(options: {
  session?: string;
  message: string;
  home?: string;
}): { session: string; tmuxSession: string; message: string } {
  const home = options.home ?? DEFAULT_HOME;
  const session = getSession(options.session || "default", home);
  const lockFile = path.join(ensureHome(home), "locks", `${safeName(session.name)}.lock`);
  if (existsSync(lockFile)) {
    throw new OrbitError(
      `Session ${session.name} is busy. Wait for the active job before steering.`,
      { lockFile },
    );
  }
  const id = `steer-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const messagePath = path.join(ensureHome(home), "jobs", `${id}.txt`);
  writeFileSync(messagePath, `Steering update from pi-orbitals:\n${String(options.message).trim()}`);
  // paste-buffer with -d (delete buffer after) for a fire-and-forget nudge.
  pastePromptFile(session.tmuxSession, messagePath, id.slice(-8));
  return { session: session.name, tmuxSession: session.tmuxSession, message: options.message };
}

/** Capture recent terminal text from a session. */
export function captureSessionText(name: string, options: { lines?: number; home?: string } = {}): {
  session: SessionRecord;
  text: string;
} {
  const home = options.home ?? DEFAULT_HOME;
  const session = getSession(name, home);
  return { session, text: capturePaneClean(session.tmuxSession, { lines: options.lines ?? 120 }) };
}

export { sleepSync };
