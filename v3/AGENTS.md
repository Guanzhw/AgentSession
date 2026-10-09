# AgentSession 3.0 implementation

This subtree contains the sole AgentSession implementation and default runtime.
The root [development guide](../AGENTS.md) owns repository-wide invariants,
commands, and validation; this file adds native implementation boundaries.

The [3.0 delivery plan](../docs/design/agentsession-v3-delivery-plan.md) owns
stage status and exit gates. The [acceptance contract](../docs/design/agentsession-v3-acceptance-contract.md)
owns observable behavior, and the [architecture decision](../docs/design/agentsession-rust-first-architecture.md)
owns the implemented module/process boundaries. Read the relevant IDs and the
current evidence record before implementing a slice.

- Provider source files and databases remain read-only. Tests that mutate
  transcripts use copies under the ignored `tmp/` tree.
- Keep provider schemas, default paths, revisions, and event vocabulary in
  the owning Rust adapter. Core projections must not branch on provider ID.
- `provider + canonical session ID` is the public identity. A source-scope
  fingerprint isolates derived state internally; it does not change public
  references or Viewer metadata keys.
- The Rust core owns facts, search, Reader/runtime projections, and bounded
  content access. Axum and rmcp translate their respective transports;
  Svelte renders and navigates normalized facts.
- Web and stdio MCP run independently from the same Rust library. MCP stdout
  carries protocol only; diagnostics go to stderr.
- For each accepted slice, write a failing behavior test before implementation,
  run it to record RED, then implement and obtain GREEN. Validate the affected
  real Web or MCP surface on frozen and current provider data where required.
  A fixture or compiler result alone does not close a real-data acceptance ID.
- Use task-owned ports and isolated Viewer/derived state for validation. Inspect
  process ownership before restarting an existing listener; preserve user state.
  Historical comparisons remain pinned to their original source and artifacts.
- Record the command, revision, corpus hash, actual result, and limitations
  in the delivery plan/evidence record. Run the root governance check and
  review the final diff before handoff.
