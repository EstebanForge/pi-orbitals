# pi-orbitals — handoff

**Repo:** `/workspaces/8d30c9fa20088e4b/ActitudStudio/pi-orbitals`
**Remote:** github.com/EstebanForge/pi-orbitals · branch `main` · **clean at `90e647d`** · all pushed
**What it is:** Pi extension driving claude/codex/agy as **interactive tmux sessions** (subscription quota, not headless `-p` billing). 7 tools + an `orbitals/{claude,codex,agy}` Pi provider. Replaces the acpx/noacp skills.

## Done & shipped (Phases 0-4)
- **Phase 1** delegation: `orbit_start/send/steer/status/capture/kill` + ORBIT_DONE marker / done.json completion protocol (idle-TUI-pattern is the real completion floor).
- **Phase 2** hook bridge: `bin/orbit-hook.mjs` recorder + per-agent hook configs + `orbit_events` tool. Session-map job attribution.
- **Phase 3** Pi provider: `streamSimple` delegates a turn to a reusable tmux session; hook events → thinking deltas; done.json `final_response` = reply.
- **Phase 4** polish: `npm run ci` (typecheck + 19 tests + ci-smoke), migration table, changelog, agent-status table.
- **Peer review (claude, via acpx exec):** 1 blocker + 4 majors + minors. ALL fixed in `56a2d2d`. Verified each claim against code first.

**Commands:** `npm run ci` (full check) · `pi -e .` (load) · `pi --model orbitals/claude -p "..."` (provider test). No build step (raw TS, Node >=22.6 `--experimental-strip-types`).

## Agent status
| Agent | Status |
|---|---|
| **claude** | VERIFIED — full e2e delegation + hooks + provider |
| **codex** | READY (marked per Esteban) — calibrated against binary; never live-tested due to **API quota wall until Jul 4 2026** (not a code issue) |
| **agy** | PARTIAL — **the open work, see below** |

## ═══ CURRENT TASK: fix agy (in progress, NOTHING committed yet) ═══

### Finding 1 — `--dangerously-skip-permissions` does NOT make agy unattended-safe
Empirically confirmed: launching `agy -i --dangerously-skip-permissions` STILL shows a command-execution prompt:
```
● Bash(mcp-cli-ent)
Requesting permission for: mcp-cli-ent
Do you want to proceed?
> 1. Yes  2. Yes, and always allow (conversation)  3. ... (Persist to settings.json)  4. No
```
The flag says "auto-approve all tool permission requests" but does NOT cover the terminal/command-execution gate. This hangs unattended runs.

### Finding 2 — the fix (from docs + empirically verified)
Docs (https://antigravity.google/docs/cli-reference, fetched via agent-browser since the page is JS-rendered) define a `toolPermission` setting in `~/.gemini/antigravity-cli/settings.json`:
- `"request-review"` (default, prompts for write/bash/web)
- `"proceed-in-sandbox"`
- **`"always-proceed"` (never prompts)** ← the fix
- `"strict"`

Plus `artifactReviewPolicy` (code-review gate): set to **`"always-proceed"`** too.
Also `/permissions` slash command switches presets. Only launch-override flags are `--sandbox` and `--dangerously-skip-permissions` (neither fully covers it).

**Verified:** I wrote `toolPermission:"always-proceed"` + `artifactReviewPolicy:"always-proceed"` to settings.json, launched agy — it ran the startup workflow (ListDir, Read) with **ZERO prompts** and reached idle `>` + `? for shortcuts`. Then I restored the user's original settings. **User settings are currently clean/restored (confirmed: no always-proceed keys).**

### Finding 3 — the catch (decision needed, was about to ask Esteban)
agy settings.json is **USER-GLOBAL** (`~/.gemini/antigravity-cli/settings.json`). No per-session flag works, no project-scope, no env var documented. Options:
1. **Backup user settings.json → merge always-proceed on `orbit_start` → restore on `orbit_kill`.** Crash-risk: if Pi dies between, user's global agy is left in always-proceed. Session outlives a single Pi call, so restore timing is fiddly.
2. **Document only; require user to set it themselves.** Honest, no side-effects, agy stays "manual setup required" out-of-box.
3. **Leave global always-proceed permanently.** Simplest but invasive (affects interactive agy too).
4. **Check if agy honors a config-dir/HOME env var** (e.g. `GEMINI_HOME` or `XDG`) to isolate an orbit-specific settings.json. NOT yet checked — **try this first** (`env | grep`, `agy install --help`, or strace the settings read). Cleanest if it works.

### Finding 4 — `defaultModel("agy")` is WRONG (separate bug)
`profiles.ts` `defaultModel("agy")` returns `"gemini-2.5-pro"` — **invalid**. `agy models` lists real names WITH spaces/parens: `Gemini 3.5 Flash (Low|Medium|High)`, `Gemini 3.1 Pro (Low|High)`. Fix to e.g. `"Gemini 3.5 Flash (Low)"`. Note: shell-quoting handles spaces fine (`agy --model 'Gemini 3.5 Flash (Low)'` works — confirmed in banner). `ORBIT_AGY_MODEL` env override should also default to a valid name.

### Finding 5 — agy hook recorder may be broken too (NEEDS VERIFICATION)
During the agy provider test, events showed `hookEventName:"unknown"`. EITHER the agy hook payload shape (agy 1.0.8) differs from what `bin/orbit-hook.mjs`'s normalizer expects, OR the `ls -t` grabbed a stale file. **Not yet isolated.** Check `buildAgyHooksConfig` (writes `.agents/hooks.json` in project cwd) is actually loaded by agy, and capture a real agy hook payload to compare against the normalizer. agy idle/events smoke used `toolCall.name`/`toolCall.args` shape — confirm against 1.0.8.

## Key gotchas (don't re-discover these)
- **streamSimple must be SYNC** returning the stream; push events async via an IIFE. Async→Promise fails the type.
- **registerProvider requires `baseUrl`+`apiKey`** even for custom api where streamSimple does everything (use dummies `"tmux://orbitals"` / `"orbitals-local"`).
- **Provider model IDs (`claude`/`codex`/`agy`) identify the agent but CANNOT be passed as the peer's `--model`.** Map via `defaultModel(agent)` at launch (else claude rejects `"claude"` as invalid).
- **Marker detection must be line-anchored** (own-line): the prompt instructions contain the literal `ORBIT_DONE:<id>` mid-line; a cold-start raw paste can echo it into the pane → false markerSeen before the peer works. Fixed in refreshJob (`(^|\n)ORBIT_DONE:\s*<id>(\r?\n|$)`).
- **`ORBIT_HOOK_AGENT` must PREFIX the recorder command** (env-var), not append (becomes argv → recorder defaults to claude). The B1 blocker.
- Inter-module imports use `.ts` specifiers (tsconfig: `allowImportingTsExtensions` + `verbatimModuleSyntax`).
- `@earendil-works/pi-ai` is a devDep (for provider type resolution; not at top-level otherwise).
- Peers launch with bypass flags (deliberate, security callout in README).
- Bidirectional Pi-tool bridge intentionally omitted (peer agents have own tools; YAGNI).

## House style
org: `@estebanforge/*` scoped npm, raw-TS no-build, MIT, AGENTS.md + CLAUDE.md/GEMINI.md symlinks. Peer-reviewed plans before implementation.

## Memory
7 facts in agentmemory (cross-session): Phase 3 provider bug, agent-readiness decision, migration decision, type-stripping resolution, TUI smoke calibration, org extension house-style, local typecheck gotcha. **Search memory first** (`memory_search "pi-orbitals"`).

## Suggested next steps (in order)
1. Check if agy honors a config-dir/HOME env var (Finding 3 option 4) — cleanest fix if it exists.
2. Pick the agy permission approach with Esteban (global settings.json side-effect is a real decision).
3. Fix `defaultModel("agy")` to a valid model name (Finding 4).
4. Verify + fix the agy hook recorder payload shape (Finding 5) — capture a real agy hook event.
5. Run a full agy e2e (delegation + hooks + provider) to flip agy to VERIFIED.
6. Codex can't be tested until Jul 4 2026 (quota).
