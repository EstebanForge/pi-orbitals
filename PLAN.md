# pi-orbitals — Plan

Drive peer coding agents (claude, codex, agy) as **interactive tmux sessions** from a single Pi extension, instead of spawning them in headless print mode. Replaces the `acpx` and `noacp` skills.

## Why

`-p` / print / headless mode bills per-token API quota (and gets throttled hard). Interactive TUI mode rides the flat subscription quota. Running each peer agent in a tmux pane and driving it with keystrokes dodges the `-p` cost while keeping the peer's own context window (so per-turn token cost stays flat, unlike noacp which re-sends full history).

## Goal

One Pi extension, three agents. Send a task, get a structured result back, with live progress and (later) a provider surface. No per-token billing for peer turns.

## Naming (confirm)

- Package: `@estebanforge/pi-orbitals`
- Tool prefix: `orbit_` (`orbit_start`, `orbit_send`, ...)
- State dir: `~/.pi/orbitals/`
- Tmux session prefix: `orbit-<name>`

## References

- Engine template: `claude-code-tmux` (ccmux) at `/tmp/claude-code-tmux`. Borrow: tmux lifecycle, paste-buffer delivery, completion-marker protocol, done-file, per-job JSONL events, provider + tool bridge.
- Packaging template: `ActitudStudio/pi-agentmemory` (`@estebanforge/pi-agentmemory`). Borrow: scoped name, `package.json` shape, `tsconfig` (no-build raw TS), `AGENTS.md` style, `CLAUDE.md`/`GEMINI.md` symlinks, README/CHANGELOG, MIT.
- Hook systems (all three have native hooks, near-identical event model):
  - claude: `settings.json` hooks (PreToolUse/PostToolUse/Stop/UserPromptSubmit/...). JSON on stdin. Fields: `tool_name`, `tool_input`, `hook_event_name`, `session_id`.
  - codex: `~/.codex/hooks.json` or `[hooks]` in `config.toml`. Same event names. Needs `--dangerously-bypass-hook-trust` for unattended use. Fields add `turn_id`, `model`. Tools: `Bash`, `apply_patch` (alias Edit/Write), MCP.
  - agy: `.agents/hooks.json` or `~/.gemini/config/hooks.json`. Events: PreToolUse/PostToolUse/PreInvocation/PostInvocation/Stop. Fields use `toolCall.name`/`toolCall.args`, `conversationId`, `stepIdx`. Tools: `run_command`, `write_to_file`, `view_file`, `replace_file_content`, ...

## Architecture (layered)

1. **Agent profiles** (declarative registry, one per agent):
   - `launch(opts)` -> command string (binary + model + skip-perms + agents-md injection)
   - `hooks`: config-file location + format + trust flag
   - `agentsMd`: `inject` (claude) | `native` (codex, agy read AGENTS.md themselves)
   - `readyPatterns`: idle/trust TUI regex
   - `toolNames`: optional normalization map for replay
2. **tmux driver** (pure functions, agent-agnostic): start/kill/capture/has-session, paste-prompt (load-buffer + paste-buffer `-pr`, verify visible, retry on `C-u`, submit `C-m`), pipe-pane log.
3. **Job + completion protocol** (agent-agnostic): uuid + marker `ORBIT_DONE:<id>` injected into prompt, optional `done.json`, `waitForJob` polling log tail with settle.
4. **Hook bridge**: standalone recorder script invoked by each agent's hooks, writes per-job JSONL; a normalizer maps agent stdin fields to one canonical event schema.
5. **State**: `~/.pi/orbitals/state.json` (sessions, jobs) + `logs/*.ansi.log` (pipe-pane) + `events/<job>.jsonl`.
6. **Pi extension surface**: tools (Phase 1), events reader (Phase 2), provider + tool RPC (Phase 3).

## Repo structure

```
pi-orbitals/
  AGENTS.md                      # project KB (mirror agentmemory style)
  CLAUDE.md -> AGENTS.md
  GEMINI.md -> AGENTS.md
  README.md
  CHANGELOG.md
  LICENSE                        # MIT
  package.json                   # @estebanforge/pi-orbitals, pi.extensions, files whitelist
  tsconfig.json                  # noEmit, strict, raw-TS consumed by Pi
  .gitignore
  extensions/
    orbitals/
      index.ts                   # entry: register tools (p1) + provider (p3)
      profiles.ts                # claude/codex/agy profiles
      tmux.ts                    # tmux driver (functional)
      jobs.ts                    # job + completion protocol
      state.ts                   # state.json + logs
      hooks.ts                   # hook config generators + event normalizer (p2)
      provider.ts                # Pi provider + tool bridge (p3)
  bin/
    orbit-hook.mjs               # standalone hook recorder (p2), self-contained
    orbit-pi-tool.mjs            # agent->Pi tool RPC (p3), self-contained
  test/
    profiles.test.ts             # node:test (--experimental-strip-types)
    jobs.test.ts
    state.test.ts
    hooks.test.ts
```

### Structural note (deviation from agentmemory, justified)

agentmemory is pure raw-TS with no tests and no subprocess scripts. orbitals needs both. Two consequences:

- `bin/*.mjs` are **self-contained** (no import from the TS extension) because the agent's hooks invoke them as standalone `node` processes. The recorder is tiny (~40 lines: read stdin, normalize, append JSONL). The pi-tool bridge (~100 lines) is likewise standalone.
- Tests run on `.test.ts` via `node --test --experimental-strip-types` (Node 22.6+). **Fallback** if type-stripping is flaky: move pure logic to `src/*.mjs` (ccmux structure) and have the TS extension import it. Either way, no build step.

This keeps the no-build invariant while gaining testability and standalone subprocess scripts.

## Phases

### Phase 0 — Scaffold

- `package.json` (scoped name, `pi.extensions: ["./extensions/orbitals"]`, `files: ["extensions","bin","README.md"]`, peerDeps `@earendil-works/pi-coding-agent` + `typebox` optional, `engines.node ">=22.6"` for `--experimental-strip-types`)
- `tsconfig.json` (strict, noEmit, include `extensions/**/*.ts`)
- `AGENTS.md` (+ `CLAUDE.md`/`GEMINI.md` symlinks), `README.md` skeleton, `CHANGELOG.md`, `LICENSE`, `.gitignore`
- Empty module files so `tsc --noEmit` is green
- **Verify:** `npx tsc --noEmit` passes; `pi -e .` loads the extension with zero tools registered.

#### Phase 0.5 — Flag verification (peer-review fix)

Before Phase 1 coding, mechanically verify each agent's launch + bypass flags against the installed binary (peers flagged these as risky; one review wrongly guessed two flags). Record exact strings in `profiles.ts`:
- claude: `--append-system-prompt[-file]`, `--dangerously-skip-permissions`, `--model`, `--effort` (confirmed real)
- codex: `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, `-m`, `-a never`, `-s` (confirmed real)
- agy: `--dangerously-skip-permissions`, `-i`, `--model` (confirmed real)
- For each, also note any first-run trust/EULA prompt the TUI shows and how `orbit_start` will auto-answer it.

### Phase 1 — Agent-agnostic delegation core (the cost win, replaces acpx/noacp)

Deliverable: send a task to claude/codex/agy in tmux, get a result back. No hooks, no provider yet.

- `profiles.ts`: launch builders per agent. **`cwd` is a required parameter** (load-bearing; ccmux has it; without it the peer starts in `~/.pi/orbitals` and cannot see project files).
  - claude: `claude --model <m> --effort <e> --dangerously-skip-permissions [--append-system-prompt-file <f>]` (AGENTS.md injected via the file flag; claude reads only `CLAUDE.md` natively)
  - codex: `codex -m <m> --dangerously-bypass-approvals-and-sandbox` (AGENTS.md read natively)
  - agy: `agy -i --model <m> --dangerously-skip-permissions` (AGENTS.md read natively)
- `tmux.ts`: `startSession` (with explicit dimensions `new-session -d -x 120 -y 40` so TUIs do not wrap or trigger pagers), `killSession`, `capturePane`, `hasSession`, `pastePrompt` (paste-buffer + visibility verify + retry on `C-u` + submit `C-m`), `pipePane` log, `clearHistory` (run before each new prompt to kill stale marker matches in scrollback).
- `jobs.ts`: `makeJob`, `buildPrompt` (injects `ORBIT_DONE:<id>` + done.json instruction), `waitForJob` (poll log tail for marker / done.json, settle window, timeout), `steerSession`. **`waitForJob` must check `hasSession` each poll** and transition to a `failed` job state if the pane dies, so a crashed peer does not spin to timeout with no signal.
- **Idle detection is the real completion floor, not the marker.** Per-agent `idleDetector` checks pane text for the agent's "input-ready" TUI pattern (claude: `❯` + trust prompt; codex/agy: to map in 0.5). The marker (`ORBIT_DONE`) only *accelerates* detection; if a peer drops the marker, the job still completes when the idle pattern appears. This is critical for codex/agy, where marker-instruction compliance is not guaranteed.
- `state.ts`: load/save `state.json`, `ensureHome` (`~/.pi/orbitals/{logs,jobs,events}`), `stripAnsi`, `safeName`, `shellQuote`, **`withSessionLock(name, fn)`** per-session lockfile (`~/.pi/orbitals/locks/<name>.lock`) so concurrent `orbit_send` to one pane queue rather than collide. `steer` is refused while a job holds the lock.
- `index.ts` tools: `orbit_start` (takes `cwd`), `orbit_send` (with `--wait`), `orbit_steer`, `orbit_status`, `orbit_capture`.
- **`orbit_send` return schema** (peer-review fix, must be defined here not deferred): `{ id, status: "sent"|"done"|"timeout"|"failed", markerSeen: boolean, doneFile: object|null, logTail: string, finalResponse: string|null, session: string }`. Callers that need `acpx --format json` parity do NOT get it in Phase 1; Phase 1 replaces acpx/noacp **only for callers that accept this semi-structured response**.
- **Hook normalizer scaffolding (peer-review fix, agy):** land `normalizeHookEvent(agent, payload)` in Phase 1 (claude shape only) even though the recorder is Phase 2, so `waitForJob`'s event-poll path is designed against the canonical schema from day one and is not rewritten later.
- Tests (deterministic, no agent auth): `buildPrompt` protocol injection, launch-command building per profile, `safeName`/`stripAnsi`/`shellQuote`, state round-trip, marker/done-file refresh logic, session-lock acquire/release.
- **Verify:** `npx tsc --noEmit`; `node --test`; manual smoke: `orbit_start --cwd <repo>` + `orbit_send --wait "reply with ok"` against each agent, marker or idle pattern observed, result object returned. Cost check: confirm the peer runs interactive (no `-p`).

### Phase 2 — Hook bridge (structured output for all three)

Deliverable: per-job structured lifecycle/tool events for claude, codex, and agy.

- `bin/orbit-hook.mjs`: self-contained. Reads JSON stdin, normalizes to canonical event `{jobId, hookEventName, toolName, toolInput, toolResponse, turnId, sessionId, ts}`, appends to `events/<jobId>.jsonl`. Exit 0, `{suppressOutput:true}` on stdout (non-blocking).
- `hooks.ts`:
  - `normalizeHookEvent(agent, payload)`: field mappers (agy `toolCall.args` -> `toolInput`; codex `turn_id` preserved; shared `session_id`/`conversationId`).
  - Per-agent config generators:
    - claude: per-session `settings.json` with command hooks pointing at `orbit-hook.mjs --home <h>`.
    - codex: `~/.codex/hooks.json` (or scoped) + launch with `--dangerously-bypass-hook-trust`.
    - agy: `.agents/hooks.json` (project) or `~/.gemini/config/hooks.json` (user).
  - **Job-id binding (peer-review fix): hooks do NOT receive the orbit job id.** The hook script gets only the agent runtime ids (`session_id` / `turn_id` / `conversationId`). Bind job id by side-channel: at `sendJob` time, write a session-scoped env/file mapping (`~/.pi/orbitals/hooks/<tmuxSession>.job` = current jobId) that the hook script reads. Clear it when the job completes. (ccmux additionally extracts job id from prompt text as a fallback; we keep that as a secondary resolver, not the primary.)
- `orbit_events` tool + `events` CLI: read `events/<jobId>.jsonl` with offset.
- Tests: hook config generation per agent; `normalizeHookEvent` for each agent's field shape; job-id extraction from prompt text.
- **Verify:** `node --test`; manual: run a tool-touching task on each agent, confirm `events/<job>.jsonl` records PreToolUse/PostToolUse/Stop with normalized fields.

### Phase 3 — Pi provider + tool bridge (full ccmux parity x3)

Deliverable: register `orbitals/{claude,codex,agy}` as Pi model providers; stream hook events as progress; let the peer call Pi-native tools.

- `provider.ts`: `pi.registerProvider("orbitals", { models: [...], streamSimple })`. Provider prompt embeds Pi system prompt + recent messages + tool list + done-protocol (require `final_response`). Polls job + events; emits thinking/progress deltas from hook events; returns `final_response`.
- Replay: map agent tool calls (from hook events) into Pi tool calls (`orbit_replay_tool_result`) so Pi's transcript stays coherent. Per-agent tool-name normalization optional.
- `bin/orbit-pi-tool.mjs`: agent runs `orbit-pi-tool call --job <id> --tool <name> --args-json '<j>'`; writes request file, blocks on response file. Extension polls pending requests, emits the Pi tool call, writes the response back.
- `steer`: mid-turn paste already in core; expose as provider-safe steering.
- **Verify:** `pi -e . --model orbitals/claude --thinking low -p "reply exactly: works"`; same for codex and agy; file-edit smoke; native-tool-bridge smoke.

### Phase 4 — Polish

- Deterministic CI smoke (no agent auth): packaging, module load, hook recording, pi-tool broker. Mirror ccmux `ci-smoke.mjs`.
- Provider matrix (manual, needs real agents): fresh workspace, reused session, file edit, AGENTS.md import, each agent, hook recording, replay.
- `README.md` + `AGENTS.md` full content; env-var table; troubleshooting. **Security callout must live here** (README + AGENTS.md), not only in this plan: peers launch with bypass flags and have unrestricted read/write/network access to the current user's environment. State this explicitly with the implication. Note Docker/Nix sandbox as a future mitigation.
- Delete `acpx` + `noacp` skills from `ActitudStudio/AGENTS` only here, after Phase 2 verification (peer-review fix: do not delete at Phase 1).
- Migration doc: how `orbit_*` maps to old `acpx`/`noacp` verbs; what is not replaced (queued `--no-wait`, `--format json`).
- Publish: `npm publish --dry-run`; `pi -e npm:@estebanforge/pi-orbitals`.

## Design decisions (peer-reviewed; claude + agy approved 2026-06-15)

1. **Naming:** `@estebanforge/pi-orbitals`, prefix `orbit_`, dir `~/.pi/orbitals`. Approved by both.
2. **Phasing:** Phase 1 first (cost win + acpx/noacp replacement), Phase 2 hooks, Phase 3 provider. Approved with one change (agy): build the claude `normalizeHookEvent` in Phase 1 so `waitForJob` is not rewritten in Phase 2. Reflected above.
3. **No-build invariant:** raw-TS extension + self-contained `bin/*.mjs` + `node --test --experimental-strip-types` (Node >=22.6, now in `engines`). Approved; `src/*.mjs` split is the documented fallback.
4. **Security:** peers launch with bypass flags (claude/agy `--dangerously-skip-permissions`, codex `--dangerously-bypass-approvals-and-sandbox`) and codex hook-trust bypass. Approved as a deliberate trade-off, with the requirement that the security callout lives in README + AGENTS.md (added to Phase 4 and Honest risks).
5. **acpx/noacp fate:** keep both skills in `ActitudStudio/AGENTS` until orbitals Phase 2 is verified (agy: do not delete at Phase 1), then delete in Phase 4. Reflected above.

## Honest risks

- **Phase 1:** codex/agy TUI idle/trust markers must be reverse-engineered. **The true completion floor is the idle TUI pattern, not the marker** (codex/agy may not emit the marker reliably). Marker instruction-compliance is a real risk for non-Claude models; mitigated by idle detection, but a peer that neither idles predictably nor emits the marker will spin to timeout.
- **Phase 1 crash/durability:** if the peer process dies mid-turn (OOM, API error, network drop), `waitForJob` must detect it via `hasSession` and mark the job `failed`. State.json survives Pi restarts, but reconnecting to an existing tmux session on extension load is not in Phase 1 scope (document as a gap).
- **Security:** bypass flags give the peer unrestricted filesystem + network access as the current user. No workspace isolation in Phase 1. This is a deliberate, documented trade-off; the README/AGENTS.md callout is required, not optional.
- **Phase 2:** codex hook-trust flow (`/hooks`, hash review) needs the bypass flag and may need a one-time accept. agy field naming (`toolCall.args`) differs but is mappable. Per-agent config file locations must match real installs.
- **Phase 3:** provider is best-effort terminal automation (same as ccmux). Marker/done-file compliance depends on the peer model. Streaming fidelity is lower than a real API.
- **Cross-agent:** queueing (`--no-wait`) and structured `--format json` from acpx have no clean tmux equivalent; a pane is single-threaded so every send must block until the turn finishes. Flagged as accepted regression.

## Success criteria

- Phase 1 done = acpx/noacp core use cases replaced for all three agents **for callers accepting the semi-structured `orbit_send` response** (no `--format json` parity), no `-p` billing, `tsc` + `node --test` green, manual smoke green per agent, plus at least one real delegated task per agent before cutover.
- Phase 2 done = structured events flow for all three agents.
- Phase 3 done = each agent usable as a Pi provider with progress streaming and tool bridge.
- Phase 4 done = published, documented, migration guide, deterministic CI green.
