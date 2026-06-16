import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

/** Root state directory. Override with ORBIT_HOME. */
export const DEFAULT_HOME =
  process.env.ORBIT_HOME || path.join(os.homedir(), ".pi", "orbitals");

export const STATE_VERSION = 1;

/** Default per-agent model flag values (override with ORBIT_DEFAULT_MODEL). */
export const DEFAULT_MODELS: Record<string, string> = {
  claude: process.env.ORBIT_CLAUDE_MODEL || "opus",
  codex: process.env.ORBIT_CODEX_MODEL || "gpt-5.1",
  agy: process.env.ORBIT_AGY_MODEL || "gemini-2.5-pro",
};

export const DEFAULT_AGENT = process.env.ORBIT_DEFAULT_AGENT || "claude";

export type JobStatus =
  | "queued"
  | "sent"
  | "done"
  | "timeout"
  | "failed";

export interface JobRecord {
  id: string;
  marker: string;
  agent: string;
  session: string;
  tmuxSession: string;
  cwd: string;
  promptPath: string;
  donePath: string;
  logPath: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
}

export interface SessionRecord {
  name: string;
  agent: string;
  tmuxSession: string;
  cwd: string;
  command: string;
  logPath: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  reused: boolean;
  /** Whether the orbit hook recorder is enabled for this session. */
  hooksEnabled?: boolean;
  /** Path to the agent-specific hook config file, if any. */
  hookConfigPath?: string;
}

export interface OrbitState {
  version: number;
  sessions: Record<string, SessionRecord>;
  jobs: Record<string, JobRecord>;
}

export class OrbitError extends Error {
  readonly details: Record<string, unknown>;
  constructor(
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "OrbitError";
    this.details = details;
  }
}

/** Expand a leading ~ to the user home. */
export function expandHome(value: string | undefined): string {
  if (!value) return "";
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** tmux-safe slug: a-zA-Z0-9_.- only, trimmed, capped at 60 chars. */
export function safeName(value: string | undefined): string {
  const cleaned = String(value || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return cleaned || "default";
}

/** Single-quote a shell argument. */
export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

/** Block the thread for ms milliseconds (Atomics.wait based). */
export function sleepSync(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Create the state directory tree. Returns the root. */
export function ensureHome(home: string = DEFAULT_HOME): string {
  const root = expandHome(home);
  for (const sub of ["logs", "jobs", "events", "locks", "hooks", "instructions"]) {
    mkdirSync(path.join(root, sub), { recursive: true });
  }
  return root;
}

function statePath(home: string = DEFAULT_HOME): string {
  return path.join(ensureHome(home), "state.json");
}

export function loadState(home: string = DEFAULT_HOME): OrbitState {
  const file = statePath(home);
  if (!existsSync(file)) {
    return { version: STATE_VERSION, sessions: {}, jobs: {} };
  }
  // Corrupt state.json (SIGKILL mid-write, disk error) must not crash the
  // extension. Fall back to a fresh state rather than propagating.
  let parsed: Partial<OrbitState>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<OrbitState>;
  } catch {
    return { version: STATE_VERSION, sessions: {}, jobs: {} };
  }
  return {
    version: parsed.version ?? STATE_VERSION,
    sessions: parsed.sessions ?? {},
    jobs: parsed.jobs ?? {},
  };
}

export function saveState(state: OrbitState, home: string = DEFAULT_HOME): void {
  const file = statePath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

export function getSession(name: string, home: string = DEFAULT_HOME): SessionRecord {
  const state = loadState(home);
  const safe = safeName(name || "default");
  const session = state.sessions[safe];
  if (!session) throw new OrbitError(`No orbit session named ${safe}`);
  return session;
}

export function listSessions(home: string = DEFAULT_HOME): SessionRecord[] {
  return Object.values(loadState(home).sessions);
}

export function getJob(id: string, home: string = DEFAULT_HOME): JobRecord {
  const state = loadState(home);
  const job = state.jobs[id];
  if (!job) throw new OrbitError(`No orbit job ${id}`);
  return job;
}

/** Strip ANSI escape sequences and normalize CR to newline. */
export function stripAnsi(value: string): string {
  return String(value || "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()#][0-9A-Za-z]/g, "")
    .replace(/\r/g, "\n");
}

/** Read the last maxBytes of a file as utf8. */
export function readTail(file: string, maxBytes = 64 * 1024): string {
  if (!file || !existsSync(file)) return "";
  // The stat/open/read window can race with orbit_kill deleting the log;
  // never let a transient fs error propagate as an uncaught rejection.
  try {
    const stats = statSync(file);
    const start = Math.max(0, stats.size - maxBytes);
    const length = stats.size - start;
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buffer, 0, length, start);
    } finally {
      closeSync(fd);
    }
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

function escapeRegExp(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lockfile path for a session. */
export function sessionLockPath(name: string, home: string = DEFAULT_HOME): string {
  return path.join(ensureHome(home), "locks", `${safeName(name)}.lock`);
}

/**
 * Per-session mutex. acquires a lockfile by writing a marker and verifying
 * ownership. Returns a release function. Throws if the session is already busy.
 *
 * This is advisory, single-process-safe (sufficient because all orbit_send
 * calls route through one Pi extension process). For multi-process safety,
 * upgrade to flock; not needed for the current single-process model.
 */
export function acquireSessionLock(
  name: string,
  home: string = DEFAULT_HOME,
): () => void {
  const lockFile = sessionLockPath(name, home);
  if (existsSync(lockFile)) {
    throw new OrbitError(
      `Session ${safeName(name)} is busy with an active job. Wait for it to finish before sending again or steering.`,
      { lockFile },
    );
  }
  writeFileSync(lockFile, String(process.pid));
  return () => {
    try {
      if (existsSync(lockFile)) {
        const owner = readFileSync(lockFile, "utf8").trim();
        // Only remove if we still own it (pid matches, or stale empty marker).
        if (owner === String(process.pid) || owner === "") {
          unlinkSync(lockFile);
        }
      }
    } catch {
      // lock cleanup is best-effort
    }
  };
}

export { escapeRegExp };
