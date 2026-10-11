# Implementation design

## CLI ownership

Keep argument routing in the npm Viewer entrypoint, and keep parsing and
metadata semantics in the existing Rust CLI/core. Default and option-only
invocations continue to insert `serve`. Explicit native subcommands are forwarded
without that insertion; global `--config` remains usable before the command.
Help must describe commands the installed entrypoint can actually execute.
Forward strings as an argument array through the existing native launcher.

The installed-package test is the acceptance surface: it must execute the
packed Viewer entrypoint against a task-owned legacy database copy, verify the
imported values and input hash, and retain actual Viewer/MCP launch checks.

## Private-source validation

Use Rust's explicit ignored-test mechanism for the two private-corpus checks.
Both require an explicitly selected manifest on opt-in; a missing prerequisite
is an error during an explicitly requested run. Keep the provider assertions
and full traversal/hash checks intact. Public fixture coverage remains part of
the normal test gate.

## Documentation and evidence

Keep the operational migration guide in `v3/README.md`, linked from both root
READMEs and package documentation. Clearly separate the already-published
rc.4 commands from the corrected, unreleased wrapper behavior. Existing state
is retained by selecting another metadata root for import; this is not a merge.

Record exact rc.4 workflow URLs and outcomes in the current release ledger and
add a changelog entry. Update current acceptance summaries with bounded CI
subresults, retaining dated historical failures and missing real-source/resource
evidence. Keep mirror troubleshooting local to the install command.

## Coordination and verification

The orchestrator owns this spec, user-facing upgrade documentation, integration
checks and final judgment. One worker owns npm routing and its installed-package
regressions; another owns private-source test reporting; a third owns current
release/acceptance record reconciliation. Workers do not edit each other's files.

After the implementation workers finish, run the repository review gate and
relevant Rust, metadata and installed-artifact checks. Use an independent fresh
review of the final diff, then repair and repeat only affected checks. Record
actual commands, failures, host restrictions and remaining gates in `tasks.md`.
