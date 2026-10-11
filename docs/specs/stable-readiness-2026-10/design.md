# Stable readiness execution design

## Evidence ownership

Use the existing acceptance contract and stable gate table as the rubric. Bind
each new result to its exact source, binary, embedded UI, inputs and host. Reuse
earlier results only when their covered inputs still match. Keep preserved
failures, unavailable samples and human feedback distinct from automated passes.

The orchestrator owns the spec, integration, candidate identity, full checks and
final judgment. Separate workers investigate source coverage, historical state
attribution, and release packaging. Each worker has explicit read-only or file
ownership boundaries. Independent review follows validated repairs.

## Candidate isolation

Build an optimized candidate in a separate Cargo target directory with the
repository's path remapping. The existing release executable is in use by the
pre-existing Viewer process. Task-owned services use separate loopback ports
and explicit source/config/meta/index/cache paths. Sources used for mutation
scenarios are copies. Capture before/after hashes and process ownership.

## Stable publication contract

Derive one release identity from the exact version: stable `3.x.y` uses npm
`latest` and a non-prerelease GitHub release; version suffixes use npm `next` and
GitHub prerelease behavior. Keep exact tag/commit agreement, four-target sidecar
and payload checks, provenance and integrity validation. Explicit manual
validation executes gates and prepares artifacts without publishing. Version
selection, evidence collection and eventual publication remain separate steps.

## Human review

Prepare complete representative desktop flows and screenshots first. Then ask
for concrete task completion, reading comprehension and visual feedback on the
identified candidate, while continuing independent source/resource work. Keep
the human gate open until actual feedback arrives.
