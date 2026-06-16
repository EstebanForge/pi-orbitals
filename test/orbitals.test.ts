import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  safeName,
  shellQuote,
  stripAnsi,
  escapeRegExp,
  expandHome,
  loadState,
  saveState,
  ensureHome,
  acquireSessionLock,
} from "../extensions/orbitals/state.ts";
import { buildPrompt, discoverAgentsMd } from "../extensions/orbitals/jobs.ts";
import { getProfile } from "../extensions/orbitals/profiles.ts";
import {
  extractJobIdFromText,
  buildClaudeHookSettings,
  buildCodexHooksConfig,
  buildAgyHooksConfig,
  readHookEvents,
} from "../extensions/orbitals/hooks.ts";
import { spawnSync } from "node:child_process";

function tempHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), "orbit-test-"));
}

test("safeName keeps tmux-safe slugs", () => {
  assert.equal(safeName("hello world/repo"), "hello-world-repo");
  assert.equal(safeName("***"), "default");
  assert.equal(safeName(undefined), "default");
  assert.equal(safeName("a".repeat(100)).length, 60);
});

test("shellQuote single-quotes and escapes embedded quotes", () => {
  assert.equal(shellQuote("simple"), "'simple'");
  assert.equal(shellQuote("it's"), "'it'\"'\"'s'");
});

test("stripAnsi removes escape sequences and normalizes CR", () => {
  assert.equal(stripAnsi("\u001b[31mred\u001b[0m\rnext"), "red\nnext");
  assert.equal(stripAnsi("\u001b]0;title\u0007clean"), "clean");
});

test("escapeRegExp escapes regex metacharacters", () => {
  const id = "1.2-3+";
  const re = new RegExp(escapeRegExp(id));
  assert.ok(re.test(`prefix${id}suffix`));
});

test("expandHome expands leading tilde", () => {
  assert.equal(expandHome("~/foo"), path.join(os.homedir(), "foo"));
  assert.equal(expandHome("~"), os.homedir());
  assert.equal(expandHome("/abs"), "/abs");
});

test("buildPrompt injects the completion marker and done path", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const prompt = buildPrompt({ task: "Do thing", id, donePath: "/tmp/done.json" });
  assert.match(prompt, /Do thing/);
  assert.match(prompt, /ORBIT_DONE:/);
  assert.match(prompt, /orbit job 11111111-1111-4111-8111-111111111111/);
  assert.match(prompt, /\/tmp\/done\.json/);
  assert.match(prompt, /final_response/);
});

test("buildPrompt can disable the protocol", () => {
  const prompt = buildPrompt({ task: "raw", id: "x", donePath: "/d.json", protocol: false });
  assert.equal(prompt, "raw");
});

test("profiles build correct launch commands with bypass flags", () => {
  const claude = getProfile("claude").launch({ model: "opus" });
  assert.match(claude, /'--model' 'opus'/);
  assert.match(claude, /'--dangerously-skip-permissions'/);

  const claudeInjected = getProfile("claude").launch({ model: "opus", agentsPromptPath: "/tmp/a.md" });
  assert.match(claudeInjected, /'--append-system-prompt-file' '\/tmp\/a.md'/);

  const codex = getProfile("codex").launch({ model: "gpt-5.1" });
  assert.match(codex, /'-m' 'gpt-5.1'/);
  assert.match(codex, /'--dangerously-bypass-approvals-and-sandbox'/);

  const agy = getProfile("agy").launch({ model: "gemini-2.5-pro" });
  assert.match(agy, /'-i'/);
  assert.match(agy, /'--dangerously-skip-permissions'/);
});

test("profiles mark codex/agy as native AGENTS.md readers", () => {
  assert.equal(getProfile("claude").agentsMd, "inject");
  assert.equal(getProfile("codex").agentsMd, "native");
  assert.equal(getProfile("agy").agentsMd, "native");
});

test("handleMidTurnDialog is opt-in (claude none; codex/agy answer their dialogs)", () => {
  // claude has no post-paste dialog handler.
  assert.equal(getProfile("claude").handleMidTurnDialog, undefined);

  // codex: confirm the rate-limit model-switch dialog (option 1).
  const codex = getProfile("codex").handleMidTurnDialog!;
  const sentCodex: string[] = [];
  const sendCodex = (k: string) => { sentCodex.push(k); };
  assert.equal(
    codex("Approaching rate limits\nSwitch to gpt-5.4-mini for lower credit?\nPress enter to confirm or esc to go back", sendCodex),
    true,
  );
  assert.deepEqual(sentCodex, ["C-m"]);
  sentCodex.length = 0;
  assert.equal(codex("thinking about the task", sendCodex), false);
  assert.deepEqual(sentCodex, []);

  // agy: answer command-approval with option 2 (always this conversation) + Enter.
  const agy = getProfile("agy").handleMidTurnDialog!;
  const sentAgy: string[] = [];
  const sendAgy = (k: string) => { sentAgy.push(k); };
  assert.equal(
    agy("Requesting permission for: npm test\nDo you want to proceed?", sendAgy),
    true,
  );
  assert.deepEqual(sentAgy, ["2", "C-m"]);
  sentAgy.length = 0;
  assert.equal(agy("? for shortcuts", sendAgy), false);
  assert.deepEqual(sentAgy, []);
});

test("getProfile throws on unknown agent", () => {
  assert.throws(() => getProfile("nope"), /Unknown agent/);
});

test("state round-trips sessions and jobs", () => {
  const home = tempHome();
  try {
    saveState({ version: 1, sessions: { a: { name: "a", agent: "claude", tmuxSession: "orbit-a", cwd: "/x", command: "claude", logPath: "/l", createdAt: "t", updatedAt: "t", model: "opus", reused: false } }, jobs: {} }, home);
    const loaded = loadState(home);
    assert.equal(loaded.sessions.a?.agent, "claude");
    assert.equal(loaded.version, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ensureHome creates the expected subdirectories", () => {
  const home = tempHome();
  try {
    const root = ensureHome(home);
    for (const sub of ["logs", "jobs", "events", "locks", "hooks", "instructions"]) {
      assert.ok(existsSync(path.join(root, sub)), `missing ${sub}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("session lock is exclusive and releasable", () => {
  const home = tempHome();
  try {
    const release = acquireSessionLock("worker", home);
    assert.ok(existsSync(path.join(ensureHome(home), "locks", "worker.lock")));
    assert.throws(() => acquireSessionLock("worker", home), /busy/);
    release();
    // second acquire after release succeeds
    const release2 = acquireSessionLock("worker", home);
    release2();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("extractJobIdFromText finds an orbit job id", () => {
  const id = "22222222-2222-4222-8222-222222222222";
  assert.equal(extractJobIdFromText(`orbit job ${id}`), id);
  assert.equal(extractJobIdFromText("nothing here"), undefined);
});

test("claude hook settings.json includes lifecycle + tool hooks", () => {
  const home = tempHome();
  try {
    const result = buildClaudeHookSettings({ home, name: "demo" });
    assert.ok(existsSync(result.configPath));
    const parsed = JSON.parse(readFileSync(result.configPath, "utf8"));
    assert.ok(parsed.hooks.PreToolUse);
    assert.ok(parsed.hooks.PostToolUse);
    assert.ok(parsed.hooks.Stop);
    assert.ok(parsed.hooks.UserPromptSubmit);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("codex hook config adds the hook-trust bypass flag", () => {
  const home = tempHome();
  const project = mkdtempSync(path.join(os.tmpdir(), "orbit-codex-"));
  try {
    const result = buildCodexHooksConfig({ home, scope: "project", projectDir: project });
    assert.deepEqual(result.extraLaunchArgs, ["--dangerously-bypass-hook-trust"]);
    assert.ok(existsSync(result.configPath));
    const parsed = JSON.parse(readFileSync(result.configPath, "utf8"));
    assert.ok(parsed.hooks.PreToolUse);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("agy hook config writes a named recorder group", () => {
  const home = tempHome();
  const project = mkdtempSync(path.join(os.tmpdir(), "orbit-agy-"));
  try {
    const result = buildAgyHooksConfig({ home, scope: "project", projectDir: project });
    assert.equal(result.scope, "project");
    const parsed = JSON.parse(readFileSync(result.configPath, "utf8"));
    assert.ok(parsed["orbit-recorder"].PreToolUse);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("recorder subprocess attributes + normalizes events across agents", () => {
  const home = tempHome();
  const recorder = path.resolve("bin", "orbit-hook.mjs");
  const jobId = "33333333-3333-4333-8333-333333333333";
  const run = (payload: object, agent: string, event?: string) =>
    spawnSync(process.execPath, [recorder, "--home", home], {
      input: JSON.stringify(payload),
      env: { ...process.env, ORBIT_HOOK_AGENT: agent, ...(event ? { ORBIT_HOOK_EVENT: event } : {}) },
      encoding: "utf8",
    });
  try {
    // bind session s1 -> job via the prompt text
    run({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: `orbit job ${jobId}` }, "claude");
    // same session, no prompt -> auto-attributed, tool fields normalized (claude shape)
    run({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }, "claude");
    // agy payloads omit the event name; ORBIT_HOOK_EVENT (set per-matcher in the
    // hook config) identifies it. toolCall.* is normalized regardless.
    run({ conversationId: "s1", toolCall: { name: "run_command", args: { CommandLine: "pwd" } } }, "agy", "PreToolUse");

    const page = readHookEvents(jobId, { home });
    assert.equal(page.events.length, 3);
    const [a, b, c] = page.events as any[];
    assert.equal(a.hookEventName, "UserPromptSubmit");
    assert.equal(b.toolName, "Bash");
    assert.equal(c.toolName, "run_command"); // agy toolCall.name normalized
    assert.equal(c.toolInput.CommandLine, "pwd");
    assert.equal(c.hookEventName, "PreToolUse"); // resolved from ORBIT_HOOK_EVENT (agy payload omits it)
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("discoverAgentsMd walks parent to child", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "orbit-agents-"));
  try {
    const child = path.join(root, "repo", "nested");
    mkdirSync(child, { recursive: true });
    writeFileSync(path.join(root, "repo", "AGENTS.md"), "parent");
    writeFileSync(path.join(child, "AGENTS.md"), "child");
    const files = discoverAgentsMd(child);
    assert.deepEqual(files.map((f) => path.basename(f)), ["AGENTS.md", "AGENTS.md"]);
    assert.equal(files[0] && files[1] ? true : false, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
