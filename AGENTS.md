# PROJECT KNOWLEDGE BASE

**Generated:** 2026-06-15

## OVERVIEW
Project: **pi-orbitals** (`@estebanforge/pi-orbitals`)
Stack: TypeScript 5.8+, Node.js 22.6+, ES2022 modules, Pi Extension API, TypeBox schemas, tmux 3.5+

Pi-native extension that drives peer coding agents (claude, codex, agy) as **interactive tmux sessions** instead of headless print mode. Replaces the `acpx` and `noacp` skills. Goal: peer turns ride the flat subscription quota, not per-token `-p` API billing.

## STRUCTURE
```
extensions/orbitals/
  index.ts        # Extension entrypoint — tools (p1) + provider (p3)
  profiles.ts     # Agent launch profiles (claude/codex/agy)
  tmux.ts         # tmux driver (functional, agent-agnostic)
  jobs.ts         # Job + completion protocol (ORBIT_DONE marker + done.json)
  state.ts        # state.json + logs + session locks
  hooks.ts        # Hook config generators + event normalizer (p2)
  provider.ts     # Pi provider + agent->Pi tool bridge (p3)
bin/
  orbit-hook.mjs  # Standalone hook recorder, self-contained (p2)
  orbit-pi-tool.mjs # agent->Pi tool RPC, self-contained (p3)
test/
  *.test.ts       # node:test (--experimental-strip-types)
```
- `extensions/`: Pi extension source (raw TypeScript, consumed by Pi runtime, `noEmit`)
- `bin/`: standalone subprocess scripts invoked by agent hooks (cannot import the TS extension)
- No build step. `package.json` `"files"` whitelist: `extensions`, `bin`, `README.md`

## COMMANDS
| Action | Command |
|--------|---------|
| Install deps | `npm install` |
| Type-check | `npm run typecheck` (`tsc --noEmit`) |
| Test | `npm test` (`node --test --experimental-strip-types`) |
| Smoke load | `pi -e .` |

## CODING STANDARDS
- **Language**: TypeScript strict mode, ESNext modules, ES2022 target. No build step.
- **Style**: Functional with local helpers; no classes. Named exports. `async/await` over `.then()`
- **Types**: `import type` for type-only imports. TypeBox (`Type.Object`) for tool parameter schemas. Inline type aliases at module level.
- **Imports**: Node builtins use `node:` prefix (`node:path`, `node:crypto`, `node:child_process`)
- **Error handling**: Return structured results / `null` on failure rather than throwing where callers need resilience; throw an `OrbitError` for programmer/usage errors.
- **Naming**: camelCase functions/variables, PascalCase type aliases. Tool prefix `orbit_`.
- **tmux**: always quote targets via `shellQuote`. Send prompts with `paste-buffer -pr` (not `send-keys -l`) for multiline safety.

## ARCHITECTURE (layered)
1. **Agent profiles** — declarative per-agent: `launch(opts)`, hooks config, agentsMd mode, idle patterns, tool-name map.
2. **tmux driver** — `startSession` (`-d -x 120 -y 40`), `killSession`, `capturePane`, `hasSession`, `pastePrompt` (load-buffer + paste-buffer + visibility verify + retry on `C-u` + `C-m`), `pipePane`, `clearHistory`.
3. **Job + completion protocol** — uuid + `ORBIT_DONE:<id>` marker injected into prompt + optional `done.json`; `waitForJob` polls log tail, checks `hasSession` each loop (failed state on pane death), settle window, timeout.
4. **Hook bridge** (p2) — standalone recorder `bin/orbit-hook.mjs` writes per-job JSONL; job-id bound via a session-scoped side-channel file (NOT from agent output).
5. **State** — `~/.pi/orbitals/{state.json,logs,jobs,events,locks,hooks}`.
6. **Pi surface** — tools (p1), events reader (p2), provider + tool RPC (p3).

## KEY DESIGN RULES
- **cwd is required** on `orbit_start`. Without it the peer starts in `ORBIT_HOME` and cannot see project files.
- **Idle TUI pattern is the real completion floor**, not the marker. The marker accelerates; non-compliant peers (codex/agy) still complete via idle detection.
- **Per-session mutex** (`withSessionLock`). Concurrent `orbit_send` to one pane queues; `steer` refused while locked.
- **Crash detection**: `waitForJob` checks `hasSession` each poll; dead pane => job `failed`, not timeout.
- **clearHistory before each prompt** to avoid stale marker matches in scrollback.

## SECURITY
Peers launch with bypass flags and have unrestricted filesystem + network access as the current user. Deliberate, documented trade-off. See README security warning. Future mitigation: container/VM sandbox.

## WHERE TO LOOK
- **Plan**: `PLAN.md` (full phases, peer-review fixes, risks, decisions)
- **Source**: `extensions/orbitals/`
- **Config**: `package.json` (pi.extensions), `tsconfig.json`

## ENVIRONMENT VARIABLES
| Variable | Default | Purpose |
|----------|---------|---------|
| `ORBIT_HOME` | `~/.pi/orbitals` | State/logs/events/locks dir |
| `ORBIT_DEFAULT_AGENT` | `claude` | Default peer agent |
| `ORBIT_DEFAULT_MODEL` | per agent | Model flag value |
| `ORBIT_WAIT_TIMEOUT_MS` | `600000` | Default `orbit_send` wait timeout |
| `ORBIT_SETTLE_MS` | `3000` | Settle window after done-file appears |

## NOTES
- Reference engine: `claude-code-tmux` (ccmux) at `/tmp/claude-code-tmux`. Borrowed: tmux lifecycle, paste-buffer delivery, marker protocol, per-job JSONL, provider + tool bridge.
- Reference packaging: `ActitudStudio/pi-agentmemory`.
- Peer-reviewed (claude + agy, 2026-06-15). Both verdict: proceed with changes. Fixes folded into PLAN.md.
