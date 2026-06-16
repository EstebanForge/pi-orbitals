# @estebanforge/pi-orbitals

Pi extension to drive **claude**, **codex**, and **agy** (Antigravity) as **interactive tmux sessions**.

Interactive TUI mode rides the flat subscription quota. Headless `-p` mode bills per-token against API quota and gets throttled. pi-orbitals keeps each peer agent running in a durable tmux pane and drives it with `tmux` keystrokes, so delegated peer turns do not incur `-p` costs.

> Status: Phases 1 to 3 done and verified: agent-agnostic delegation (1), hook bridge / structured events (2), and the Pi provider (3). See [PLAN.md](./PLAN.md).

## Agent status

| Agent | Status | Basis |
| --- | --- | --- |
| **claude** | Verified | Full end-to-end runs: delegation, hook events, provider |
| **codex** | Ready | Launch flags + idle markers calibrated against the installed binary; code path identical to claude. Live end-to-end run pending an API-quota reset (rate-limited at implementation time) |
| **agy** | Partial | Launch + idle/interrupt markers calibrated; hook-field normalization unit-tested. Full delegation/provider run + a command-approval workaround still pending (agy's bypass flag does not cover its command-approval prompts) |

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
| `orbit_events` | Read structured lifecycle/tool events recorded by the hook recorder for a job |

## Provider (use a peer as a Pi model)

pi-orbitals also registers an `orbitals` provider, exposing each peer agent as a Pi model:

| Model | Agent |
| --- | --- |
| `orbitals/claude` | Claude |
| `orbitals/codex` | Codex |
| `orbitals/agy` | Antigravity |

Route any Pi prompt (or subagent) to a peer on its interactive quota:

```
pi --model orbitals/claude -e . -p "Summarize src/"
```

Each call delegates one assistant turn to a durable, reusable tmux session. Hook events stream back as thinking deltas; the peer's `done.json` `final_response` becomes the reply. The peer uses its own tools (full access via bypass flags); the bidirectional Pi-native-tool bridge is intentionally omitted.

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
| `ORBIT_PROVIDER_TIMEOUT_MS` | `1200000` | Provider per-turn timeout |
| `ORBIT_PROVIDER_POLL_MS` | `700` | Provider event-poll interval |

## How it works

1. `orbit_start` launches the peer (`claude`/`codex`/`agy`) in a detached tmux session (`orbit-<name>`), sized 120x40, in the given `cwd`.
2. `orbit_send` pastes a prompt that appends a completion protocol: emit an `ORBIT_DONE:<job-id>` marker and optionally write a `done.json`.
3. `waitForJob` polls the tmux log tail for the marker / done-file. The **real completion floor is the agent's idle TUI pattern**; the marker only accelerates detection. If the pane dies, the job fails fast instead of spinning to timeout.

See [PLAN.md](./PLAN.md) for the full architecture, phases, and risks.

## Migrating from acpx / noacp

pi-orbitals replaces the `acpx` and `noacp` skills. Verb mapping:

| Old | New |
| --- | --- |
| `acpx claude exec ...` / `noacp` send | `orbit_start` + `orbit_send` |
| `acpx claude steer ...` | `orbit_steer` |
| `acpx sessions` / `noacp` list | `orbit_status` |
| `acpx capture` | `orbit_capture` |
| `acpx kill` | `orbit_kill` |
| (none) | `orbit_events` (new: structured lifecycle/tool events) |

Not yet replaced: queued `--no-wait` dispatch and `--format json` parity. `orbit_send` returns a semi-structured job result (`{ id, status, markerSeen, doneFile, logTail, finalResponse, session }`); use `doneFile`/`finalResponse` for structured output.

## Develop

```
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test --experimental-strip-types (Node >=22.6)
```

No build step. The extension is consumed by Pi as raw TypeScript.

## License

MIT
