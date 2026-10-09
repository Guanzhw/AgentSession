---
status: implemented
date: 2026-09-27
decision: Save only existing resume command and shell settings through same-origin JSON, publish them after an atomic file replacement, and retain startup launch permission.
---

# Runtime resume settings

## Context

HTTP-07 requires saved runtime settings. The existing resume resolver already
consumes `resumeCommands` and `resumeShell`; the Settings page exposed only a
startup snapshot and POST returned 405. This decision supersedes the no-live-write
portion of [the terminal boundary decision](2026-09-27-v3-resume-terminal-boundary.md).

## Decision

`POST /api/settings` accepts either or both fields directly. Each supplied field
replaces its complete value. It rejects unknown/startup-owned fields, invalid
commands, missing Origin, foreign Origin/Host and non-JSON bodies. The existing
configuration parser owns command validation. A process-local mutex serializes
saves and provides one current snapshot to Settings and resume preview/launch.

The application reads the selected configuration file, preserves unrelated
fields, validates the merged file with the same parser used at startup, writes
and syncs a uniquely named temporary sibling for each attempt, then replaces the
file. Temporary filenames include the process ID, current nanoseconds, and a
process-local sequence so abandoned files do not block later saves. Only a
successful replacement publishes the new runtime snapshot. A missing default
configuration may be created; an explicitly loaded file disappearing or becoming
invalid yields a save failure. No provider source or Viewer metadata is written.

Startup-only launch permission survives every update. `projectPaths` remains
unimplemented because this slice has no consumer for it. The Settings page
edits the two structured fields, sends only edited fields, reports errors, and
explains default/disabled behavior. This preserves independent command/shell
edits made in two open tabs. A newly opened Reader fetches the updated capability.

[The later project-path decision](2026-09-27-v3-project-paths-config-retention.md)
adds validated configuration retention without assigning a session directory.

## Alternatives considered

- Saving all settings would silently change source/scope assumptions of the
  running process and introduce fields with no consumer.
- Publishing in memory before persistence would make a failed save appear
  successful until restart.

## Consequences

Cross-process edits to one selected configuration file are not coordinated;
the side-by-side delivery uses separate configuration and state.

## Verification

`v3/test/settings-slice.test.mjs` first failed on the empty editable list and
405 POST, then passed with actual Axum save/GET/preview/restart, startup config
preservation, forbidden/invalid requests, failed-save non-publication and
unchanged provider bytes. `v3/test/ui-settings.test.mjs` first failed because
the editor was absent, then passed actual browser edits, persistence, Reader
capability and invalid-JSON handling. Related resume tests continue to cover
literal subprocess arguments and disabled launch permission.

An integrated test run encountered one browser transport timeout; the isolated
retry passed, followed by the API/browser suite at 3/3. The workspace Rust tests
passed 64 with five private cases ignored. `npm run review` and `git diff --check`
passed. The 1440-pixel desktop screenshot is retained under ignored
`tmp/v3-browser-qa/runtime-settings.png`.

Independent review identified three concrete save failures. New API tests first
reproduced an abandoned PID-named sibling returning 500 and a valid-JSON external
edit with an invalid port being accepted. A two-session browser test reproduced
a shell-only edit overwriting another page's command change. The same tests pass
with per-attempt files, merged schema validation, and field-only form requests.
The browser CLI's text wait intermittently timed out; bounded body-text polling
now records an explicit assertion if the expected state fails to appear.
One subsequent second-window pointer submission produced no save state; the
two-window regression uses Tab/Enter for that form and passed with the API and
startup-config suite at 11/11. This checks both pointer and keyboard submission
while preserving the stale-window scenario. App unit tests passed 2/2, Svelte
build and governance/typecheck passed after the review fixes.
