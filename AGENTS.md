# AgentSession Development Guide

This file is the repository-level source of truth for contributors and coding
agents. AgentSession 3.0 is the sole implementation and default runtime in this
workspace. It uses one Rust core, Axum Web routes, native rmcp stdio MCP, and a
static Svelte frontend. OpenCode, Claude Code, Codex CLI, Pi, and DeepSeek Harness
are the five supported providers.

The Web UI serves people revisiting complete conversations and understanding
how agents worked. Lead with readable requests, replies, and meaningful turning
points; progressively reveal execution and child history. Explain assignments,
collaboration, and background work from dispatch to returned results. Raw
records and diagnostics belong in technical details. MCP has its own bounded,
machine-oriented interface.

The [3.0 acceptance contract](docs/design/agentsession-v3-acceptance-contract.md)
owns observable behavior; the [delivery plan](docs/design/agentsession-v3-delivery-plan.md)
owns stage status, remaining gates, and next action. Historical 2.0 evidence
remains useful within its recorded scope. Removing its implementation does not
close open product, source, performance, or platform acceptance gates.

## Purposeful Directness

State the positive truth, recommendation, or action first. Mention limitations
when they change a decision or mark actual uncertainty or an authority boundary.
Keep explanations proportionate and concrete. Simplify unnecessary rules after
feedback rather than adding defensive prohibitions.

## Non-Negotiable Invariants

### Provider data is read-only

- Provider-owned databases, transcripts, and event logs remain read-only.
- Viewer stars, titles, and exclusion state belong in
  `v3/crates/core/src/meta.rs` and scope-isolated Viewer metadata.
- A version upgrade must preserve provider records, existing Viewer metadata,
  retired-provider rows, and historical indexes. OpenClaw and Hermes were last
  published in v1.10.1 and remain outside the five-provider runtime.
- Permanent deletion means permanently excluding a session in Viewer metadata.
- Test transcript mutation only on task-owned copies under ignored `tmp/`.

### Provider behavior stays provider-owned

Provider decoding, schemas, default paths, revision evidence, resume defaults,
and event vocabulary belong in `v3/crates/core/src/providers/`. Shared core
projections consume normalized facts; they must not interpret provider schemas
or branch on provider identity. Axum and rmcp translate transports, while Svelte
renders and navigates core-owned facts.

### Session identity must remain canonical

Use provider plus canonical session ID in URLs, metadata keys, exports, MCP,
resume commands, and relationships. Source-scope fingerprints isolate derived
state internally and never replace public identity.

### Structured rendering has stable semantics

Group tools and reasoning with their producing assistant turn. Keep reasoning
within its message boundary. The TOC includes user, assistant, assignment, and
distinct compaction checkpoints in transcript order. Reader collaboration and
Runtime projections use recorded normalized evidence. Browser code must not
infer provider semantics. Keep Rust response contracts, Svelte consumers,
locales, and browser assertions synchronized.

### System prompt claims must be evidence-based

Recorded prompts and currently resolvable instructions have distinct provenance.
Keep source paths and resolution metadata. Current files do not prove historical
use; hidden or unrecorded prompts remain explicitly unavailable.

### Session Protocol is the runtime inspection boundary

Native fact documents expose validated Protocol versions 2 and 3; these schema
numbers do not retain the removed TypeScript runtime. Native v3 preserves
same-source v2 facts and adds recorded domains. Preserve recorded versus derived
provenance. Missing tasks, runs, branches, lifecycle, or child evidence stay
missing. Bound construction work as well as output; continuation identity
includes source scope, revision, and filters.

### Terminal launch is explicitly trusted local behavior

The server binds to `127.0.0.1`. Launch is enabled by default and
`--disable-terminal-launch` disables it for the process. Launch requests require
same-origin loopback JSON. Build structured executable/argument/cwd commands;
never concatenate session data into shell text. Provider defaults remain
adapter-owned; user overrides use `resumeCommands` and `resumeShell`.

## Repository Map

```text
v3/
  Cargo.toml, Cargo.lock           locked Rust workspace
  crates/core/src/                 facts, providers, Reader, Runtime, search, metadata
  crates/app/src/                  CLI, config, Axum, rmcp, resume transport
  ui/src/                         Svelte desktop interface and localization
  fixtures/                       public source fixtures
  test/                           Node-driven Web, MCP, provider and artifact checks
  npm/                            local native Viewer/MCP package templates
scripts/                          root launch/build, governance and packaging helpers
test/governance.test.mjs           repository guidance and governance checks
docs/                             acceptance, architecture, historical evidence
.agents/                          decision lifecycle and review/pre-push workflows
tmp/, logs/, v3/target/, v3/ui/dist/ ignored runtime and generated output
```

## Source And Build Conventions

- Edit Rust, Svelte, scripts, tests, and documentation; rebuild generated assets.
- Use Node.js 22.15 or newer for development tooling and a Rust toolchain
  supporting edition 2024. Native Web/MCP binaries run without Node or Cargo.
- Keep Web and stdio MCP independent processes calling the same Rust library.
  MCP stdout carries protocol only; diagnostics go to stderr.
- Use concrete contracts and platform path helpers. Normalize timestamps to Unix
  milliseconds and strings/offsets to each API's declared units.
- Keep unavailable, invalid, unsupported, and unknown evidence explicit.
- Validate provider files, configuration, HTTP requests, and external output at
  their owning boundary; trust established typed in-process contracts afterward.
- Add abstractions, compatibility paths, and defensive tests only for an actual
  consumer or observed boundary failure.
- Preserve Windows, Linux, and macOS behavior. Platform support claims require
  actual affected-host evidence.

## Local Development

From the repository root:

```powershell
npm install
npm --prefix v3/ui ci
npm run build
npm start
```

Root installation does not build the removed TypeScript application or trigger a
prepare hook. UI dependencies are installed explicitly. `npm run build` builds
the Svelte UI and the locked Rust release; `npm start` builds and serves the
native Viewer on `http://127.0.0.1:3457`. Forward options with
`npm start -- --port 3458 --disable-terminal-launch`.
See [native CLI and configuration](v3/README.md) for source/state overrides,
stdio MCP, metadata-copy import, and packaging.

```powershell
npm run review
npm test
cargo test --workspace --manifest-path v3/Cargo.toml --locked
```

Use the actual root scripts as the command contract. The review gate checks
governance, Rust formatting, and Rust compilation. The full test gate covers
Rust and retained native integration tests; host/source-specific skips remain
explicit. Reuse successful evidence only when its covered inputs and runtime
state still match.

## Validation Matrix

| Change | Minimum validation |
| --- | --- |
| Documentation | Re-read commands, paths, names, and links; `npm run check:governance` |
| Rust types/config/helper | `npm run review` and relevant Rust or integration tests |
| Provider/parser/schema | Rust tests, relevant `v3/test` tests, and a real-data read |
| Web/API/meta/index | Relevant tests, task-owned restart, and direct API checks |
| Svelte/styles/locales | UI build, relevant tests, and desktop browser QA |
| Resume launch | Tests and actual descendant-process launch evidence |
| Protocol/Runtime | Tests, real provider/API checks, and desktop browser QA |
| MCP retrieval | Tests and actual read-only native MCP calls |
| Installer/package | Relevant tests and installed/packed-artifact checks |
| Cross-provider/refactor | Full build/test, affected Web/MCP checks, unavailable-source coverage |

A compiler or fixture result alone does not establish real provider or product
behavior. Product scope is desktop; preserve existing responsive behavior and
focus validation on the specified desktop flow. Do not close platform gates
using another host's result.

## Restart AgentSession

Build first. Inspect the listener and command line before stopping anything;
restart only the instance owned by this task. Use a separate port when an
existing service belongs to other work.

```powershell
$listeners = Get-NetTCPConnection -LocalPort 3457 -State Listen -ErrorAction SilentlyContinue
$listeners | Select-Object LocalAddress, LocalPort, OwningProcess
Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in $listeners.OwningProcess } |
  Select-Object ProcessId, ExecutablePath, CommandLine
# Stop-Process -Id <verified-task-owned-process-id>
Start-Process -FilePath (Join-Path (Get-Location) 'v3/target/release/agentsession-v3.exe') `
  -ArgumentList 'serve' -WorkingDirectory (Get-Location) `
  -RedirectStandardOutput 'app.log' -RedirectStandardError 'app-error.log' `
  -WindowStyle Hidden
Get-NetTCPConnection -LocalPort 3457 -State Listen
Invoke-RestMethod http://127.0.0.1:3457/api/providers
```

Do not use `$pid` as a PowerShell loop variable. Inspect logs if startup fails.
Existing listeners and user state require their own ownership evidence.

## Implementation and Review

Delegate independently scoped work when it materially improves speed or quality.
Keep tiny or tightly coupled work in the main agent. Use an independent review
when risk or a fresh perspective warrants it; verify findings against source and
retain final judgment. Every handoff states objective, owned scope, constraints,
acceptance checks, concrete evidence, and unresolved assumptions.

## Working Tree And Documentation Hygiene

Check `git status --short` before editing and completion. Preserve unrelated
changes and task-owned evidence. Do not commit generated assets, runtime
databases, logs, screenshots, or private corpora. Keep both READMEs, CLI help,
and settings labels aligned when behavior changes. Inspect `git remote -v`
before remote operations. Source and tests override stale prose.

## Agent-native change governance

Use the [decision lifecycle](.agents/decisions/README.md) for non-trivial
cross-module, provider/protocol, public configuration/API, persistence/release,
or security choices. Move an unsettled proposed record to implemented or
rejected when resolved. Reversals need a new linked record; historical evidence
retains its original scope. Pin links to removed historical source to its Git
revision.

Use the [review Skill](.agents/skills/review/SKILL.md) for scope and evidence
reuse, and the [pre-push Skill](.agents/skills/pre-push/SKILL.md) immediately before
a user-authorized push or release handoff. Run `git diff --check`, inspect the
intended diff, and report commands/results, reused evidence, and material gaps.

## Evidence-bounded defensive engineering

Validate at real untrusted boundaries, then trust normalized typed contracts.
Preserve unexpected failures rather than introducing silent fallback behavior.
Record consequential ownership or contract changes under `.agents/decisions/`.
