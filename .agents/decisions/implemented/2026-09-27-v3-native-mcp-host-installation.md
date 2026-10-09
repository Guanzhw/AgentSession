---
status: implemented
date: 2026-09-27
decision: Register the native 3.0 stdio MCP binary with explicit paths and a separate host entry, requiring an explicit replacement for conflicts.
---

# Native 3.0 MCP host installation

## Context

The portable 3.0 binary runs `mcp` directly, but its package instructions only
described a manual host command. The 2.0 npm installer manages `agentsession`
entries in Codex, Claude Code, and OpenCode. A 3.0 candidate needs a host
registration path without changing the 2.0 entry or a user's existing service.

## Decision

`scripts/v3-install-mcp-host.mjs`, also shipped in the portable bundle, takes
one explicit host target, native binary path, and host config file path. An
optional existing 3.0 server JSON config is passed as `--config` before `mcp`.
When `--server-config` is supplied, all five provider source paths and all
three viewer state paths must be explicit absolute paths. An empty or partial
file cannot register a host that would fall back to a personal provider root.
The installer also pins those eight paths as MCP command arguments, whose CLI
precedence prevents ambient provider environment variables from overriding
the selected isolated roots.
It registers `agentsession-v3` in the selected host. The installer preserves
other JSON keys or TOML tables, leaves identical entries untouched, and refuses
a different entry until `--replace` is supplied. Writes use a temporary sibling
and rename. It never selects a host config from HOME or CODEX_HOME implicitly.
Codex inline-table or dotted-key registrations are detected and refused before
writing; these alternate TOML forms need a manual edit rather than a duplicate
table declaration.
The targeted TOML header scan ignores examples inside multiline strings, so
`--replace` cannot remove surrounding note text by treating it as a table.
OpenCode 2.0 stores its local entries in `mcp.servers` and enables them by
default. The installer writes that shape, preserving other servers and
protocol-wide `mcp.timeout` settings. A direct `mcp.agentsession-v3` entry from
the earlier installer candidate is refused with a manual-edit diagnostic,
including under `--replace`, so the host file cannot silently keep two forms.
The host invokes the native binary directly; Node is used only once to install.

## Alternatives considered

- Reusing `agentsession` would conflict with the 2.0 MCP registration.
- Having the installer infer host paths would make an isolated test or side by
  side setup easier to point at a real user profile by mistake.
- Adding a second in-binary host-config parser would enlarge the Rust app for a
  one-time configuration task while leaving runtime independent of Node.

## Consequences

Moving the binary or server config, or changing a registered source/state path,
requires a new installer run with `--replace`.
The installer requires Node for that one-time operation and a complete
`--server-config` when that option is used. The native Web and MCP processes
still run without Node or Cargo.

## Verification

`node --test v3/test/mcp-host-installer.test.mjs` first failed 4/4 while the
installer was absent, then passed 7/7. Independent review found two further
registration hazards. Alternate Codex TOML forms reproduced the duplicate-key
failure before the parser fix; empty explicit server config reproduced a
personal-root fallback before validation. The expanded installer suite passes
9/9. A real Codex host launch also confirmed that the explicitly registered
fixture wins over a conflicting ambient `AGENTSESSION_CODEX_DIR`. Host-file tests use isolated HOME,
USERPROFILE, CODEX_HOME, XDG_CONFIG_HOME, and OPENCODE_CONFIG. An installed
Codex CLI read the isolated entry with `mcp list --json`; the entry's exact
stdio command then returned the public Codex fixture's `assistant-1` body through
the MCP client. `node --test v3/test/standalone-release.test.mjs` passed 3/3,
including copied portable Web/MCP execution and installation from the bundled
script into an isolated Codex config pointing to the copied binary.
The public fixture SHA-256 remained
`17e3638a76197a60969f83849707bda886377c6d69cd8f5a78a6620f44f7dc12`.
The integration binary was debug SHA-256
`2f54dac4354600b6bde512469573929c82612cc2ed6cc122d4b8a9caecdec997`
from the initial uncommitted candidate at HEAD `50a32e7`; final release
rebuild and real host lifecycle acceptance remain open.
An installed OpenCode 2.0.16 host revealed that the old direct `mcp.<name>`
shape was read as configuration but `opencode mcp list` reported no server.
The updated `mcp.servers.<name>` shape and legacy collision are covered by
observed-failure RED tests and the installer suite passes 10/10. In a separate XDG/OPENCODE_CONFIG
environment, the OpenCode service log recorded `mcp connected` for
`agentsession-v3` with six tools. Its CLI `mcp list` still printed no entries
before the service finished its first MCP connection; a repeat after the
`mcp connected` log reported `agentsession-v3 connected`. The test did not
modify the personal OpenCode configuration.
The installed Claude Code 2.1.207 CLI, with `CLAUDE_CONFIG_DIR` pointing to a
separate temporary profile and the installer writing that profile's
`.claude.json`, reported `agentsession-v3` connected in `claude mcp list`.
An independent review reproduced a Codex config corruption path in which a
multiline note contained a registration-shaped header. The new isolated
regression was RED before the scanner fix and GREEN afterward; the full
installer suite passed 11/11 and `npm run review` passed.
