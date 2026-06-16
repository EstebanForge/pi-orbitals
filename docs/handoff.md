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

## ═══ agy work COMPLETED (2026-06-15, tested locally on macOS) ═══

All 5 original findings resolved + 2 additional fixes surfaced via local e2e testing. `npm run ci` GREEN (19 tests). Nothing committed yet (6 files changed).

### Test results (provider path `pi --model orbitals/<agent> -e . -p "reply PONG"`)
- **claude** — WORKS. Clean 37-byte reply via done.json. (Before: noisy logTail; see fix #3.)
- **agy** — WORKS for focused turns (clean PONG). Hooks now correct (F5 fixed).
- **codex** — mechanism PROVEN (launch, trust dialog, prompt delivery all work) but CANNOT complete a turn: `gpt-5.1` returns HTTP 400 ("not supported when using Codex with a ChatGPT account"); `gpt-5.4-mini` accepted but account usage-limited until ~Jul 3 2026. Environmental, not code. codex also auto-updated 0.139.0→0.140.0 mid-launch (hasSession crash detection caught it correctly → "died during readiness check").

### Fixes applied (trace to a confirmed failure)
1. **codex trustPattern** (`profiles.ts`) — 0.139.0/0.140.0 trust text ("Do you trust the contents of this directory? ... Press enter to continue") didn't match the old pattern → dialog not dismissed → footer false-matched idlePattern → paste swallowed → 290s timeout. Fixed + VALIDATED (prompt now lands in pane).
2. **agy defaultModel** (`profiles.ts`) — `"gemini-2.5-pro"` (invalid) → `"Gemini 3.5 Flash (Low)"`. CAVEAT: agy's settings.json `model` field OVERRIDES `--model`, so this is cosmetic (agy uses its global Medium).
3. **done.json unconditional** (`jobs.ts` buildPrompt) — was conditional ("if you used tools") → claude skipped it for tool-less replies → provider `providerResponse()` fell back to noisy `job.logTail`. Made unconditional → claude now writes it → clean output. Biggest provider-quality win.
4. **agy hook recorder F5** (`hooks.ts` + `bin/orbit-hook.mjs`) — agy payload OMITS the event-name field → `hookEventName:"unknown"`. Fix: `buildAgyHooksConfig` tags each matcher with `ORBIT_HOOK_EVENT` env; recorder prefers env over payload field. VALIDATED: real agy events now show PreToolUse/PostToolUse. codex/claude unaffected (payloads include the field).

### agy permission (F1/2/3) — RESOLVED as document-only
REVISED understanding: agy 1.0.x uses a granular `permissions.allow` allowlist + `trustedWorkspaces` (NOT the `toolPermission:always-proceed` the old Findings 2/3 assumed). Esteban's `~/.gemini/antigravity-cli/settings.json` already allowlists `mcp-cli-ent`, git, make, etc. File ops + allowlisted Bash run unattended (proven). Only UNLISTED Bash prompts — reproduced live: agy ran `npm test` (not in allowlist) → "Requesting permission" → stuck → timeout. **XDG_CONFIG_HOME isolation RULED OUT** (empirically: agy still read ~/.gemini). Decision (Esteban, 2026-06-15): document-only, keep `--dangerously-skip-permissions`. Documented in README "agy permissions" section.

### External research (4 sources, for reference)
Evaluated openclaw/openclaw + firecrawl/openclaw `skills/tmux`, tmuxcheatsheet openclaw-tmux-setup article, cosformula/resilient-coding-agent-skill. Net: pi-orbitals is strictly ahead of all (already has capture-pane -J, pre-paste ready gate `groomSession`, paste-buffer, marker+done.json). Two borrowable ideas surfaced but deferred per surgical principle (neither traces to a confirmed failure after the trustPattern fix): shell-prompt-return crash detection (unreliable here — depends on unknown zsh prompt format, `>` collides with agy idle; existing hasSession detection already caught the codex auto-update death) and codex/agy read-back verify (not needed — delivery works now; existing `orbit job <id>` signature infra exists if needed later).

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
12+ facts in agentmemory (cross-session). Original 7: Phase 3 provider bug, agent-readiness decision, migration decision, type-stripping resolution, TUI smoke calibration, org extension house-style, local typecheck gotcha. Added 2026-06-15: done.json conditional bug+fix, codex gpt-5.1/quota characterization, agy allowlist permission model (XDG ruled out), agy F5 hook fix, agy permission wall reproduced. **Search memory first** (`memory_search "pi-orbitals"`).

## Suggested next steps (in order)
1. **Commit** the 6 changed files (`profiles.ts`, `jobs.ts`, `hooks.ts`, `bin/orbit-hook.mjs`, `test/orbitals.test.ts`, `README.md`) + this handoff update.
2. **codex full e2e** — re-run after ~Jul 3 2026 quota reset; also investigate `SessionStart hook failed: exit code 127` (command-not-found when codex runs the recorder hook; unverifiable while quota-blocked).
3. **agy provider prompt** (optional, low priority) — tighten `buildProviderPrompt` so agy doesn't run exploratory repo commands on trivial turns (reduces unlisted-command wall hits).
4. Consider codex `defaultModel` = `gpt-5.4-mini` for ChatGPT-account users, or document that an API key + `gpt-5.1` is required.
