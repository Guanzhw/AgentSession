---
status: implemented
date: 2026-10-01
decision: Preserve source-confirmed 2.0 configuration fields and restore explicit default-browser opening
---

# Existing configuration fields and browser opening

## Context

The exact `524f612a` package rejected known 2.0 file fields during the
isolated migration checks (`../../../tmp/v3-delivery/del05-config-524f612a/SUMMARY.md`, local evidence).
[2.0 configuration](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/config.ts) accepts `stdin: "prompt"` and an
empty resume shell; the [2.0 launcher](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/resume.ts) does not consume
stdin and uses its default shell when no executable is configured.
JSON `allowTerminalLaunch` is deliberately superseded by process startup,
JSON language is superseded by detected language, and the 2.0 `reindex` field
has no runtime consumer. The [2.0 server](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/server.ts) does consume
`open`, opening the default browser after listening.

## Decision

The [selected-config boundary](../../../v3/crates/app/src/config.rs) accepts
these known fields and preserves the raw selected file through unrelated
Settings edits. `lang`, `reindex`, and JSON `allowTerminalLaunch` remain
non-consumers; 3.0 language belongs to browser preferences, indexing remains
incremental, and launch permission remains process-owned.

The [resume boundary](../../../v3/crates/app/src/resume.rs) normalizes an empty
shell to the existing default and removes the accepted, unused `stdin: "prompt"`
from the typed command. The file retains that field. Other stdin values and
unknown top-level configuration keys remain explicit errors.

`serve --open` or file `open: true` opens the numeric loopback URL after bind
through the [platform launcher](../../../v3/crates/app/src/browser.rs), using
structured executable arguments. Spawn and nonzero-exit failures report on
stderr; the Viewer keeps serving.

## Alternatives considered

Rejecting these fields breaks a source-confirmed existing configuration.
Giving saved JSON launch permission control would change the existing startup
security boundary. Adding stdin delivery would create behavior the old launcher
did not provide. Running a shell command string is unnecessary for a fixed
platform launcher and numeric URL.

## Consequences

Unrelated runtime Settings changes retain known old file fields without giving
them new behavior. Browser opening remains an explicit startup action. Provider
sources, Viewer metadata, and the two protected comparison instances are
outside the browser-opening and resume-normalization paths.

## Verification

[Legacy configuration tests](../../../v3/test/legacy-config-preservation.test.mjs)
first produced two failures on `524f612a`; the integrated debug binary passes
four cases: file preservation and restart, default shell, saved JSON launch
permission versus process startup, and invalid boundaries. Each scratch
process closes, its PID is absent, and its listener stops; the tracked source
fixture hash is unchanged.

[Browser-opening tests](../../../v3/test/browser-open.test.mjs) recorded RED
for the old binary's rejected flag and file key. The current debug binary
passes two portable cases; the Unix missing-launcher case is skipped on
Windows. These regular tests do not open a browser.

A separate native Windows probe served only the tracked Codex fixture, used
explicit isolated source/state/config paths, and set file `open: true`. Debug
exe SHA-256 `975ad655afd24caba1acb2f40d5aac66c374af63b005ebb69cf1529790e499a3`
opened the default Edge browser at `http://127.0.0.1:22500/`; the native browser
inventory, accessibility tree, and screenshot showed the session library and
canonical fixture link. The created tab was closed; the scratch server PID
67504 and listener closed, and fixture/exe hashes stayed unchanged. Earlier
probes with redirected browser profile variables did not provide the intended
native-tab evidence; their reports remain separate in ignored
`tmp/v3-delivery/browser-open/`. Task-created background profiles were closed
by verified process ownership. The fixed comparison listeners retain their
original PIDs. Those debug observations are retained as earlier evidence.

The exact Windows portable executable `91f2d58a` then passed the four legacy
configuration cases and two browser-opening cases in the full 432-test run.
Its migration rehearsal (`../../../tmp/v3-delivery/del05-config-91f2d58a/SUMMARY.md`, local evidence)
passed 92 migration and 19 save/restart assertions, with 25 independent checks;
the actual empty old configuration and enhanced nonempty seed are distinguished.
A separate exact-package native probe set file `open: true` and opened the
default Edge tab at `http://127.0.0.1:21662/`. Its accessibility tree and screenshot
showed the Library and one canonical public fixture. The created tab was closed;
PID 23752 and its listener closed, and source/executable hashes stayed identical,
as recorded in `tmp/v3-delivery/browser-open/native-91f2d58a-lBCtH9/`.
Native browser opening on other platforms remains unverified.
