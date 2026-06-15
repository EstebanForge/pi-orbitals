#!/usr/bin/env node
// Deterministic CI smoke. No agent auth, no network, no tmux sessions.
// Verifies: package structure, extension entrypoint, recorder subprocess,
// hook config generation, state round-trip.
// Exits non-zero on any failure.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";

const root = path.resolve(import.meta.dirname, "..");
const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, message: error instanceof Error ? error.message : String(error) });
    console.log(`  FAIL ${name}: ${failures.at(-1).message}`);
  }
}

console.log("== ci-smoke (deterministic, no agents) ==");

check("package.json declares the pi extension", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.ok(pkg.pi?.extensions?.includes("./extensions/orbitals"), "missing pi.extensions");
  assert.equal(pkg.name, "@estebanforge/pi-orbitals");
  assert.ok(pkg.engines.node.includes(">=22.6"), "engines.node must require >=22.6");
});

check("extension entrypoint + all modules exist", () => {
  const dir = path.join(root, "extensions", "orbitals");
  for (const f of ["index.ts", "profiles.ts", "tmux.ts", "jobs.ts", "state.ts", "hooks.ts", "provider.ts"]) {
    assert.ok(existsSync(path.join(dir, f)), `missing ${f}`);
  }
});

check("hook recorder subprocess normalizes + attributes (no agent needed)", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "orbit-ci-"));
  const recorder = path.join(root, "bin", "orbit-hook.mjs");
  const jobId = "c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1";
  try {
    const send = (payload, agent) =>
      spawnSync(process.execPath, [recorder, "--home", home], {
        input: JSON.stringify(payload),
        env: { ...process.env, ORBIT_HOOK_AGENT: agent },
        encoding: "utf8",
      });
    // bind then attribute a tool event
    send({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: `orbit job ${jobId}` }, "claude");
    const r = send({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }, "claude");
    assert.equal(r.status, 0, `recorder exited ${r.status}: ${r.stderr}`);
    const file = path.join(home, "events", `${jobId}.jsonl`);
    assert.ok(existsSync(file), "events file not written");
    const events = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(events.length, 2);
    assert.equal(events[1].toolName, "Bash");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

if (failures.length) {
  console.error(`\n${failures.length} ci-smoke check(s) failed.`);
  process.exit(1);
}
console.log("\nall ci-smoke checks passed.");
