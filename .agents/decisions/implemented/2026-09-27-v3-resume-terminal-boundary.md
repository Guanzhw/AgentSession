---
status: implemented
date: 2026-09-27
decision: Keep 3.0 resume commands provider-owned and launch Windows terminals only through same-origin loopback JSON requests using structured startup configuration.
---

# AgentSession 3.0 terminal resume boundary

## Context

The 2.0 adapters declare OpenCode, Claude Code, Codex, and Pi commands, while
DeepSeek Harness explicitly has no source-supported resume default. The 3.0
candidate had no resume configuration, startup opt-out, or launch endpoint.
The behavior tests in
[`v3/test/resume-slice.test.mjs`](../../../v3/test/resume-slice.test.mjs)
first failed because `resumeCommands` and `--disable-terminal-launch` were
unsupported. A background Web server redirects its standard handles, so a
terminal must obtain its own console handles.

## Decision

Provider adapters own optional structured command defaults. Core resolves the
canonical session and recorded project directory. The application reads
`resumeCommands` and `resumeShell` from explicit startup configuration; a command
can override `cwd`, and false/null disables the provider. DeepSeek Harness
requires an explicit configured command. No live configuration writes are added.

GET previews capability, executable, arguments, directory, and missing evidence.
POST accepts an empty JSON object and requires a loopback Host, matching Origin,
and startup launch permission. The server continues to bind only to 127.0.0.1.
`--disable-terminal-launch` disables launch for that process. Both the v3 route
and the existing provider session resume route use the same handlers.

On Windows, a fixed PowerShell wrapper starts the terminal with independent
console handles. The fixed terminal program receives executable, arguments and
cwd as JSON environment data. Arguments are never interpolated into shell source.
The terminal uses PowerShell 7.3+ Standard native argument passing and launches
only direct `.exe` targets. PowerShell 5 corrupts quoted native arguments, and
PowerShell invocation of `.cmd`/`.bat` shims can interpret a session argument as
batch source. Resolved batch and script targets therefore report unavailable
in the GET preview; the launch endpoint rejects them before spawning a shell.
Provider defaults may additionally declare an internal npm package/bin hint,
separate from the public `ResumeCommandSpec` configuration. The application
resolves a matched `.cmd` installation prefix to that exact package manifest;
it checks the package name, bin key, relative path, canonical package containment
including junctions, and existing entry file. It executes an `.exe` directly or
passes an absolute `.js` entry as the first argument to the prefix's `node.exe`
or a direct `node.exe` found on PATH. It never interprets the shim. The package
names remain in their provider adapters; the app dispatches only by entry type.
User overrides, including false/null and explicit `.cmd` commands, bypass this
default-only mapping. Unknown layouts and missing runtimes remain unavailable.
The wrapper returns the terminal process ID within a five-second bound; timeout,
invalid config, absent executable/directory, and wrapper failures remain explicit.
Only terminal creation is confirmed, not completion of interactive provider resume.

## Alternatives considered

- A shared provider-name command switch would move provider behavior out of its
  owning adapter.
- Directly inheriting the Web process standard handles would send terminal
  output into background-server pipes.
- Guessing a DSH command would claim unsupported provider behavior.

## Consequences

Launching is Windows-only, matching 2.0's implemented platform boundary. This
slice directly opens PowerShell and does not select Windows Terminal profiles.
Linux/macOS report unavailable. All five provider identities retain canonical
session lookup; four expose defaults and DSH remains explicit-config-only.
On the validated Windows host, `@anthropic-ai/claude-code` and `@opencode/cli`
declare native `.exe` bin entries, while `@earendil-works/pi-coding-agent`
declares `dist/cli.js`. Those three defaults now resolve through their installed
manifests. Other npm package names and installation layouts need their own
provider evidence before being supported; users can configure direct commands.
The Reader displays availability and launch results. Provider source data remain
read-only. Startup changes require a restart.

## Verification

- `npm --prefix v3/ui run build`: passed.
- `cargo build --manifest-path v3/Cargo.toml -p agentsession-v3`: passed.
- `cargo test --manifest-path v3/Cargo.toml -p agentsession-core provider_defaults_preserve_source_supported_commands`:
  passed; all five provider default capabilities checked.
- `node --test v3/test/resume-slice.test.mjs v3/test/settings-slice.test.mjs v3/test/cli-config-slice.test.mjs`:
  13 tests passed. Actual HTTP requests cover startup opt-out, absent/mismatched
  Origin, JSON requirement, unknown body fields, command-disable configuration,
  missing session, invalid cwd, missing executable and missing shell. A real
  PowerShell terminal launches a harmless Node descendant which writes exact
  session ID, special-character arguments, cwd and PID evidence.
- `npm run review`: governance and TypeScript checks passed.
- `git diff --check`: passed (line-ending notices only).

The 2026-09-27 argument-boundary regression used a harmless `.cmd` shim with an
injection sentinel and a harmless Node executable with quotes, spaces, an empty
argument, `%USERNAME%`, and shell metacharacters. The `.cmd` preview/POST fail
closed, Windows PowerShell is rejected, and PowerShell 7.6.6 preserved the
executable arguments exactly. `cargo build --manifest-path v3/Cargo.toml -p
agentsession-v3`, `cargo test --manifest-path v3/Cargo.toml -p agentsession-v3`,
`node --test v3/test/resume-slice.test.mjs v3/test/settings-slice.test.mjs
v3/test/cli-config-slice.test.mjs` (16 passing), and `npm run review` passed.

The harmless test does not resume private provider conversations. Real-data
read-only capability checks and visual Reader verification are separate final
integration evidence; no cross-platform launch success is claimed.

The npm-default slice in
[`v3/test/resume-npm-slice.test.mjs`](../../../v3/test/resume-npm-slice.test.mjs)
first produced four HTTP failures and one passing override regression. After
implementation, its five public tests pass: all three observed package layouts,
malformed/name/bin/escaping/junction manifests, missing Node, user override and
disable priority, and a real Node descendant launched through the Pi default.
The descendant preserved a source-owned ID containing quotes, shell separators,
Unicode and `%USERNAME%`, and the recorded cwd; provider fixture hashes stayed
unchanged during resume. Shim sentinels never executed.

With `AGENTSESSION_V3_VERIFY_INSTALLED_RESUME=1`, the additional read-only HTTP
case resolves installed Claude Code 2.1.207, OpenCode 2.0.16, and Pi 0.80.10
against their actual manifests. It does not launch the real providers. The npm,
existing resume, settings and CLI/config suites passed together (22/22).
