# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Phase 1: agent-agnostic tmux delegation. Tools `orbit_start`, `orbit_send`, `orbit_steer`, `orbit_status`, `orbit_capture`, `orbit_kill`. ORBIT_DONE marker + done.json completion protocol; idle-TUI-pattern as the real completion floor.
- Phase 2: hook bridge. `bin/orbit-hook.mjs` recorder (claude/codex/agy), per-agent hook config generators, `orbit_events` tool, session-map job attribution, structured lifecycle/tool events.
- Phase 3: Pi provider. `orbitals/claude`, `orbitals/codex`, `orbitals/agy` models via `streamSimple`; hook events stream as thinking deltas; `done.json` `final_response` is the reply.
- Deterministic CI smoke (`npm run ci`): package structure, module presence, recorder subprocess. No agent auth required.

### Changed
- Phase 0: package scaffold (`@estebanforge/pi-orbitals`), tsconfig, MIT license, AGENTS.md.
- Readiness layer: trust-prompt acceptance, rate-limit dialog dismissal, agy autonomous-startup interrupt.
- `@earendil-works/pi-ai` added as a devDependency for provider type resolution.

### Notes
- The bidirectional Pi-native-tool bridge is intentionally omitted (peer agents have their own full toolsets via bypass flags).
