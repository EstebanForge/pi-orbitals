# @estebanforge/pi-orbitals

Pi extension that drives **claude**, **codex**, and **agy** (Antigravity) as **interactive tmux sessions**, instead of spawning them in headless print mode.

Interactive TUI mode rides the flat subscription quota. Headless `-p` mode bills per-token against API quota and gets throttled. pi-orbitals keeps each peer agent running in a durable tmux pane and drives it with `tmux` keystrokes, so delegated peer turns do not incur `-p` costs.

> Status: Phase 1 (agent-agnostic delegation). Provider + hook-bridge land in later phases. See [PLAN.md](./PLAN.md).

## Install

```
pi install npm:@estebanforge/pi-orbitals
```

Requires `tmux` on PATH and at least one of `claude`, `codex`, `agy`.

## Tools

| Tool | Description |
| --- | --- |
| `orbit_start` | Start or reuse an interactive peer agent session in tmux (takes `cwd`) |
| `orbit_send` | Send a task and optionally wait for completion (returns a structured job result) |
| `orbit_steer` | Send a live steering update to a running session (refused while a job holds the lock) |
| `orbit_status` | List sessions and jobs |
| `orbit_capture` | Capture recent terminal text from a session |
| `orbit_kill` | Kill a peer agent tmux session and remove it from state |

## Security warning

Peer agents are launched with bypass flags (`claude`/`agy` `--dangerously-skip-permissions`, `codex` `--dangerously-bypass-approvals-and-sandbox`) and therefore have **unrestricted read, write, and network access as the current user**. No workspace isolation is applied. This is a deliberate trade-off for unattended tmux driving. Run in a sandboxed environment (container, VM) if untrusted work is involved. `codex` hooks additionally require `--dangerously-bypass-hook-trust`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ORBIT_HOME` | `~/.pi/orbitals` | State, logs, events, locks directory |
| `ORBIT_DEFAULT_AGENT` | `claude` | Default peer agent |
| `ORBIT_DEFAULT_MODEL` | per agent | Model flag value |
| `ORBIT_WAIT_TIMEOUT_MS` | `600000` | Default `orbit_send` wait timeout |
| `ORBIT_SETTLE_MS` | `3000` | Settle window after done-file appears |

## How it works

1. `orbit_start` launches the peer (`claude`/`codex`/`agy`) in a detached tmux session (`orbit-<name>`), sized 120x40, in the given `cwd`.
2. `orbit_send` pastes a prompt that appends a completion protocol: emit an `ORBIT_DONE:<job-id>` marker and optionally write a `done.json`.
3. `waitForJob` polls the tmux log tail for the marker / done-file. The **real completion floor is the agent's idle TUI pattern**; the marker only accelerates detection. If the pane dies, the job fails fast instead of spinning to timeout.

See [PLAN.md](./PLAN.md) for the full architecture, phases, and risks.

## Develop

```
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test --experimental-strip-types (Node >=22.6)
```

No build step. The extension is consumed by Pi as raw TypeScript.

## License

MIT
