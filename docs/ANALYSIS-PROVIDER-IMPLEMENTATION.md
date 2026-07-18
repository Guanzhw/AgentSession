# Implementing Session Analysis for Provider Adapters

This guide is for coding agents adding session-analysis support to another
provider. It assumes the provider already has a basic adapter as described in
[`CONTRIBUTING-PROVIDER.md`](./CONTRIBUTING-PROVIDER.md).

Session analysis is not a new parser format and not a provider-data migration.
It is a proposal-only workflow that snapshots normalized provider data into a
bounded evidence interface, runs a configured analyzer, validates the analyzer
outputs, and optionally launches a separate implementation handoff after a
human accepts the proposals.

## What Done Means

A provider is analysis-capable only when all of these are true:

- The adapter exposes enough normalized session data for useful evidence.
- The adapter declares `capabilities.sessionAnalysis: true`.
- `analysis.enabled` is true and the selected target resolves to a valid
  command for that provider.
- The session has a valid project directory.
- A live analysis run reaches `manifest.state === "completed"` with
  `manifest.validation.ok === true`.
- The run contains valid `outputs/report.md`,
  `outputs/evaluation-proposals.json`, and
  `outputs/artifact-proposals.json`.
- Provider-owned databases and transcript files remain read-only.

Do not call analysis support done just because the launch endpoint returns
`ok: true`. The launch response only proves that a local process was started.
The validator result in `manifest.json` is the success gate.

The currently verified analysis-capable adapters are OpenCode, Claude Code,
and Codex CLI. The source provider and analyzer are separate concerns: the
provider owns the normalized session evidence and runtime extensions, while
the configured analyzer command executes the proposal workflow. For example,
a Codex session may be evaluated by a configured OpenCode-backed analyzer
without changing the evidence provider or writing to Codex-owned data.

## Architecture

The core code paths are:

| Concern | Source |
|:---|:---|
| Provider contract | `src/providers/interface.ts` |
| Provider capability helpers | `src/providers/kinds.ts` |
| Analysis preparation, launch, implementation handoff | `src/analysis.ts` |
| Run-file layout | `src/analysis-layout.ts` |
| Evidence generation | `src/analysis-evidence.ts` |
| Access manifest for analyzers | `src/analysis-access.ts` |
| Read-only query helper bundled into each run | `src/analysis-tools.ts` |
| Output validation | `src/analysis-validator.ts` |
| Built-in and provider target inheritance | `src/analysis-targets.ts` |
| HTTP routes and page wiring | `src/server.ts` |
| Detail-page controls | `src/views/session.ts`, `src/static/app.js` |
| Regression tests | `test/core.test.mjs` |

Do not add central `if (provider.id === "...")` branches for a new provider.
Use adapter capabilities and optional adapter methods.

## Provider Contract

Start with the baseline `ProviderAdapter`:

```ts
export interface ProviderAdapter {
  id: ProviderId;
  name: string;
  icon: string;
  resumeCommand?: ResumeCommandSpec;
  capabilities?: {
    localManagement?: boolean;
    sqliteSessionStore?: boolean;
    sessionAnalysis?: boolean;
    structuredSessionViews?: boolean;
  };
  detect(): boolean;
  getDataPath(): string | null;
  scan(): AsyncIterable<RawSession>;
  getSession(sessionId: string): RawSession | Record<string, unknown> | null;
  getMessages(sessionId: string): Message[];
  getTokenStats(days?: number): DailyTokenStat[];
  searchMessages(query: string, limit?: number): SearchResult[];
  exportSession(sessionId: string): unknown;
  getRuntimeEnvironment?(sessionId: string): RuntimeEnvironmentView | null;
  getSystemPrompts?(sessionId: string): unknown;
  getTrace?(sessionId: string): unknown;
  getSessionTree?(sessionId: string): unknown;
  getSessionContainer?(sessionId: string): unknown;
  getSessionMetrics?(sessionId: string): unknown;
  getSessionFlow?(sessionId: string): unknown;
  getUnavailableReason?(): string | null;
}
```

The minimum analysis implementation is:

```ts
capabilities: {
  sessionAnalysis: true,
  structuredSessionViews: true
}
```

This is only safe after the provider returns canonical session IDs, stable
message IDs, a valid project directory, normalized messages, and defensively
handles corrupt source records.

## Evidence Quality Ladder

Analysis works with a fallback, but complicated workflow sessions need richer
provider-owned structure. Use this ladder when deciding how far to implement.

### Level 1: Flat Evidence

Required methods:

- `getSession(sessionId)`
- `getMessages(sessionId)`

`src/analysis-evidence.ts` will call `buildMessageSessionViews()` when
`getSessionContainer()` is unavailable. This creates a single-session view from
normalized messages. It is good enough for simple providers with no child
session model.

Normalize messages carefully:

- `Message.id` must be stable within the provider session.
- `Message.sessionId` must be the provider's canonical session ID.
- `Message.role` should use `user`, `assistant`, `system`, or `tool` where the
  provider allows it.
- `Message.content` should contain readable text when the record has text.
- `Message.thinking` should carry visible reasoning or thinking records.
- Tool calls should use `toolName`, `toolInput`, `toolOutput`, and
  `metadata.isError` when the provider exposes error state.
- Token fields should map to `tokens.input`, `tokens.output`,
  `tokens.reasoning`, `tokens.cache.read`, `tokens.cache.write`, and
  `tokens.total` where available.

### Level 2: Structured Session Views

Recommended methods:

- `getSessionTree(sessionId)`
- `getSessionContainer(sessionId)`
- `getSessionMetrics(sessionId)`
- `getSessionFlow(sessionId)`

The evidence writer prefers `getSessionContainer()` when it exists. A useful
container preserves:

- root session metadata
- ordered messages
- text, reasoning, tool, patch, and generic parts
- tool status and explicit error reasons
- child sessions attached to the tool/task part that created them
- detached children when the provider cannot attach them to a specific part
- aggregate metrics for messages, parts, tool calls, descendants, tokens,
  runtime, and cost when available

For long sessions and subagent-heavy workflows, this level is the practical
baseline. A flat transcript loses the structure needed for hierarchy-aware
analysis.

### Level 3: Provider Runtime Context

Recommended method:

- `getRuntimeEnvironment(sessionId)`

Runtime extensions are provider-owned instructions and behavior. They are not
the same as configured analysis materials. Examples include:

- instruction files such as `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`
- skills
- agents or subagents
- commands
- plugins
- hooks
- tools
- rules
- provider extension bundles

Use helpers from `src/providers/shared/runtime-environment.ts` where possible:

- `buildRuntimeEnvironment()`
- `createRuntimeExtension()`
- `runtimeInstructionFiles()`
- `scanRuntimeChildren()`
- `projectDirectories()`
- `readJsonLike()`

Runtime entries must be evidence-based. If the provider transcript does not
contain an immutable historical extension manifest, describe the result as
`current-local`, not as a perfect reconstruction of the original run.

### Level 4: System Prompt and Trace Evidence

Optional methods:

- `getSystemPrompts(sessionId)`
- `getTrace(sessionId)`

Use `getSystemPrompts()` only for locally resolvable or transcript-backed prompt
sources. Do not claim to recover hidden provider prompts. Preserve source paths,
availability, and resolution metadata so the UI and analyzer can distinguish
resolved content from unavailable content.

Use `getTrace()` when the provider has richer step/span data that cannot be
represented as ordinary message parts.

## Implementation Steps

### 1. Confirm the Baseline Provider Is Correct

Before adding analysis, verify:

- `scan()` yields sessions without throwing on one bad file.
- `getSession(id)` and `getMessages(id)` use the same canonical ID.
- `getSession(id).directory` resolves to a real project directory for sessions
  that should be analyzable.
- Messages are ordered and timestamps use Unix milliseconds.
- Tool results carry enough status to separate success from failure.
- Provider source files are never written.

If the provider has parent/child session IDs, normalize them at the parser or
structured-view boundary. Do not invent alternate IDs for URLs or metadata keys.

### 2. Add the Capability

In `src/providers/<id>/adapter.ts`:

```ts
capabilities: {
  sessionAnalysis: true,
  structuredSessionViews: true
}
```

Keep other capabilities truthful:

- `localManagement` means the viewer can mutate viewer-owned metadata for local
  management operations, not provider data.
- `sqliteSessionStore` means the provider uses the shared SQLite read path.
- `structuredSessionViews` means detail-page tree, metrics, flow, or container
  views are available or can be built safely.

### 3. Implement Runtime Environment Discovery

Create `src/providers/<id>/runtime-environment.ts` when the provider has
provider-owned instructions or extensions. Then wire it from the adapter:

```ts
getRuntimeEnvironment(sessionId) {
  const session = this.getSession(sessionId);
  return session?.directory
    ? buildMyProviderRuntimeEnvironment(sessionId, session.directory, getMyProviderDir())
    : null;
}
```

Rules for runtime entries:

- Resolve project entries from the recorded session directory.
- Resolve user entries from the provider's configured data directory or home
  location.
- Mark package/config entries as unavailable or non-capturable when there is no
  concrete local file or directory to snapshot.
- Keep provider search paths in the provider directory, not in
  `analysis-targets.ts`.
- Do not add provider runtime directories to built-in `artifactRoots`.

### 4. Implement Structured Views for Complex Providers

For message-only providers, `buildMessageSessionViews()` may be enough. For
providers with child sessions, compaction, task tools, or detached work, add
provider-owned structured view modules:

```text
src/providers/<id>/
|-- session-tree.ts
|-- session-container.ts
|-- session-metrics.ts
|-- flow-tree.ts
`-- runtime-environment.ts
```

The adapter should expose:

```ts
getSessionTree(sessionId) {
  return buildMyProviderSessionTree(sessionId);
},
getSessionContainer(sessionId) {
  return buildMyProviderSessionContainer(sessionId);
},
getSessionMetrics(sessionId) {
  return buildMyProviderSessionMetrics(sessionId);
},
getSessionFlow(sessionId) {
  return buildMyProviderFlowTree(sessionId);
}
```

Use shared helpers under `src/providers/shared/` only when they are genuinely
schema-neutral. Provider-specific field assumptions belong in
`src/providers/<id>/`.

### 5. Configure Analyzer Commands

The UI only shows analysis controls when:

- the adapter supports `sessionAnalysis`
- `analysis.enabled === true`
- the selected target resolves
- the configured executable is available
- the session has a valid project directory
- terminal launch is enabled

Global defaults are inherited by all analysis-capable providers. If the default
OpenCode analyzer command is not correct for the new provider, configure a
provider override:

```json
{
  "analysis": {
    "enabled": true,
    "defaultTarget": "docs",
    "providers": {
      "my-provider": {
        "command": {
          "executable": "my-agent",
          "args": [
            "run",
            "Read the attached analysis request and write the requested proposal files.",
            "--dir", "{projectPath}",
            "--file", "{promptPath}"
          ]
        },
        "implementation": {
          "command": {
            "executable": "my-agent",
            "args": [
              "run",
              "Read the attached implementation request and implement the accepted proposals.",
              "--dir", "{projectPath}",
              "--file", "{implementationPromptPath}"
            ]
          }
        }
      }
    }
  }
}
```

Supported analysis placeholders include:

- `{sessionId}`
- `{projectPath}`
- `{target}`
- `{runId}`
- `{runDir}`
- `{sessionPath}`
- `{sessionIndexPath}`
- `{evidenceIndexPath}`
- `{evidencePath}`
- `{accessManifestPath}`
- `{messagesPath}`
- `{analysisToolPath}`
- `{promptPath}`
- `{reportPath}`
- `{evaluationSeedPath}`
- `{evaluationPath}`
- `{proposalsPath}`
- `{artifactsPath}`
- `{prompt}`

Implementation commands also support:

- `{implementationPromptPath}`
- `{acceptedProposalsPath}`
- `{implementationResultPath}`
- `{analysisPromptPath}`

Commands are executable/argument arrays. Do not concatenate session IDs or paths
into a shell string.

### 6. Configure Targets

Analysis targets choose the provider-neutral materials to snapshot. Built-in
targets live in `src/analysis-targets.ts`; provider-specific overrides live in
configuration:

```json
{
  "analysis": {
    "targets": {
      "docs": {
        "artifactRoots": ["docs"],
        "artifactFiles": ["README.md"],
        "fileExtensions": [".md", ".mdx", ".txt"]
      }
    },
    "providers": {
      "my-provider": {
        "defaultTarget": "docs",
        "targets": {
          "docs": {
            "prompt": "Focus on durable provider documentation.",
            "artifactRoots": ["docs", "guides"],
            "fileExtensions": [".md"]
          }
        }
      }
    }
  }
}
```

Relative `artifactRoots`, `artifactFiles`, and `outputDir` resolve from the
session project directory. `fileExtensions` filters files under artifact roots.
It does not restrict explicitly selected runtime extension files.

### 7. Preserve Run Layout

New runs use:

```text
<project>/.agentsession/analysis/<run>/
|-- manifest.json
|-- outputs/
|   |-- report.md
|   |-- evaluation-proposals.json
|   |-- artifact-proposals.json
|   `-- implementation-result.json
|-- inputs/
|   |-- session.json
|   |-- evaluation-seed.json
|   |-- analysis-access.json
|   |-- analysis-request.md
|   `-- accepted-proposals.json
|-- evidence/
|   |-- session-index.json
|   |-- evidence-index.json
|   |-- evidence.jsonl
|   |-- artifacts.json
|   `-- artifact-snapshots/
|-- tools/
|   |-- analysis-tools.js
|   |-- analysis-layout.js
|   `-- package.json
`-- diagnostics/
    |-- analyzer.stdout.log
    |-- analyzer.stderr.log
    |-- messages.json
    |-- tree.json
    |-- container.json
    |-- metrics.json
    |-- flow.json
    `-- trace.json
```

Analyzer stdout/stderr logs live in `diagnostics/` for every run. The session
detail's **Analysis activity** panel exposes available logs for active, failed,
and invalid runs, and provides a copyable PowerShell analyzer command for local
recovery. The large raw
diagnostic snapshots are written only when `analysis.includeRawSnapshots` or the
target-level `includeRawSnapshots` is true.

Keep `src/analysis-layout.ts`, validators, tools, downloads, tests, and docs in
sync if this layout changes. Legacy flat runs and legacy
`.opensessionviewer/analysis` project runs must remain discoverable.

### 8. Keep the Analyzer Interface File-First

Every run writes `inputs/analysis-access.json`. Analyzers should start there and
then read bounded backing stores:

- `evidence/session-index.json`
- `evidence/evidence-index.json`
- `evidence/evidence.jsonl`
- `evidence/artifacts.json`

The bundled helper under `tools/analysis-tools.js` is optional convenience. It
must not be the only path to useful evidence. If command execution fails, the
analyzer should continue with direct file reads.

Analyzer outputs must cite exact IDs from the run:

- `ev:...` evidence IDs from `evidence-index.json`
- `artifact:...` artifact IDs from `artifacts.json`

Never cite raw session IDs, shortened prefixes, paths, line numbers, or
annotated IDs in `sourceEvidence` or `evidence` arrays.
Analyzers must copy the literal `evidenceId` or `artifactId` field value; they
must not reconstruct IDs from `sequence`, `kind`, titles, source labels, decoded
system-prompt parts, or filename-like text in the index. `sequence` is display
order only, not a citation key.

### 9. Validate Proposal Outputs

The analyzer must write:

- `outputs/report.md`
- `outputs/evaluation-proposals.json`
- `outputs/artifact-proposals.json`

The validator checks at least:

- output files exist
- JSON schemas are valid
- evaluation cases include replay, held-out, and regression coverage
- every case has `metrics.taskSuccess === true`
- every evidence and artifact reference resolves
- proposal actions are `create`, `edit`, `replace`, or `delete`
- proposal `kind`, when present, is `artifact-change` or `skill-evolution`
- proposal targets stay inside captured artifact roots
- generated analysis output is never targeted
- integrity hashes for captured inputs still match

Exit code zero is not success. The gate is:

```json
{
  "state": "completed",
  "validation": {
    "ok": true,
    "errors": []
  }
}
```

### 10. Keep Implementation Handoff Separate

Implementation is intentionally separate from analysis:

1. Analyzer produces proposals.
2. Validator marks the run completed or invalid.
3. The user reviews the proposals.
4. The session page can launch implementation only when the completed run has
   valid proposals and a configured implementation command.

The approval record is written to `inputs/accepted-proposals.json`. The first
pass accepts the whole validated proposal set; future UI can narrow that list
without changing the implementation contract. The implementation request is
written to `inputs/implementation-request.md`. It points back to the accepted
proposal file, original proposal file, report, artifact inventory, and analysis
access manifest. The implementation agent is asked to write
`outputs/implementation-result.json` with implemented proposal IDs, skipped
proposal IDs, changed files, and verification results. None of this bypasses
the human approval gate.

## Tests to Add or Update

For a new analysis-capable provider, add focused tests in `test/core.test.mjs`
or adjacent provider tests if the suite is split later.

Minimum coverage:

- The adapter declares `capabilities.sessionAnalysis === true` only after the
  provider can produce useful evidence.
- `resolveAnalysisSettings(provider, { enabled: true }, target)` returns a
  setting for the provider.
- A provider without `sessionAnalysis` returns `null`.
- `getSessionAnalysisAction()` exposes target metadata for an available command.
- `prepareSessionAnalysis()` writes the categorized run layout.
- `evidence/session-index.json` contains the canonical root session ID.
- `evidence/evidence-index.json` contains useful `session`, `message`, `tool`,
  `text`, `reasoning`, and provider-specific records where applicable.
- Runtime extensions are captured only through `getRuntimeEnvironment()`.
- Generated analysis directories are excluded from artifact snapshots.
- Validator success and failure paths are covered with valid and invalid output
  proposals.
- `prepareAnalysisImplementation()` writes
  `inputs/accepted-proposals.json` and `inputs/implementation-request.md` only
  for completed validated runs with proposals.

For complex providers, also test:

- child sessions under task/tool parts
- detached child sessions
- compaction or summary records
- tool-only assistant turns
- reasoning placement
- interrupted or failed tool records
- token aggregation, including cache and reasoning tokens
- unavailable-provider behavior

## Live Verification

Use fixtures for fast iteration, but finish with real provider data when the
change depends on provider schemas, paths, child sessions, token accounting, or
browser rendering.

Typical verification:

```bash
npm run build
node --test --test-name-pattern="session analysis" test/core.test.mjs
npm test
```

Then restart the local app with the provider's real data path and a writable
metadata path. Use the normal repo instructions in `AGENTS.md` for Windows
server launch when testing Windows provider paths.

Check provider availability:

```bash
curl -fsS http://127.0.0.1:3456/api/providers
```

Open the provider detail page and confirm the analysis control is present for a
real session with a project directory. For API-level smoke testing:

```bash
curl -fsS \
  -X POST \
  "http://127.0.0.1:3456/api/my-provider/session/<session-id>/analyze" \
  -H "Content-Type: application/json" \
  --data '{"target":"docs"}'
```

Poll the run list:

```bash
curl -fsS \
  "http://127.0.0.1:3456/api/my-provider/session/<session-id>/analyses"
```

Report the final:

- `runId`
- `runDir`
- `manifest.state`
- `manifest.validation.ok`
- validation errors, if any
- evaluation case count
- artifact proposal count
- evidence record count and important kinds
- child-session or detached-child counts for complex sessions
- whether implementation was available or launched

For browser-visible changes, also run:

```bash
npm run qa:e2e
```

Use a real session ID that contains reasoning, tools, tokens, and subagent
activity when the provider supports those concepts.

## Review Checklist for Coding Agents

Before finishing an analysis-provider change:

- [ ] No provider-owned database or transcript writes were added.
- [ ] No central provider-ID branch was added where a capability or adapter
      method should be used.
- [ ] Canonical provider session IDs are used in URLs, run IDs, metadata keys,
      exports, and evidence IDs.
- [ ] `getSession(id)` and `getMessages(id)` agree on IDs and timestamps.
- [ ] Complex workflow structure is represented through provider-owned
      structured views, not guessed in `src/analysis.ts`.
- [ ] Runtime environment discovery is provider-owned and evidence-based.
- [ ] Built-in `artifactRoots` do not include provider runtime directories.
- [ ] `analysis.providers.<provider>` command and target overrides are
      documented or tested when the default command is inappropriate.
- [ ] A valid run reaches `manifest.validation.ok === true`.
- [ ] An invalid analyzer output is rejected by the validator.
- [ ] The live app shows the analysis action only when the provider capability,
      config, executable, project directory, and terminal-launch gate all pass.
- [ ] Server logs are clean after the live run.
- [ ] README and provider docs point to this guide when support changes.

## Common Failure Modes

| Symptom | Likely Cause | Fix |
|:---|:---|:---|
| Detail page has no analysis button | Missing `sessionAnalysis` capability, disabled config, unavailable executable, invalid project directory, or terminal launch disabled | Check `getSessionAnalysisAction()` inputs and `/api/providers` |
| Launch returns `ok: true` but run fails | Analyzer process started but did not produce valid outputs | Inspect `diagnostics/analyzer.stderr.log` and `manifest.validation.errors` |
| Validator rejects evidence IDs | Analyzer used raw session IDs, shortened prefixes, paths, or annotated IDs | Read exact IDs from `evidence-index.json` and `artifacts.json` |
| Validator rejects proposal paths | Proposal targets generated run files or paths outside captured artifact roots | Use artifact roots from `evidence/artifacts.json` |
| Long sessions produce poor analysis | Provider only exposes flat messages | Implement provider-owned `getSessionContainer()` with child and detached sessions |
| Runtime skills or prompts are missing | Provider did not implement `getRuntimeEnvironment()` or marked entries non-capturable | Add provider-owned runtime discovery with concrete source paths |
| Analysis query helper works in repo but not in analyzed project | Helper depends on repo-local paths | Use the run-local `tools/analysis-tools.js` and direct backing-store reads |
| Browser still shows old behavior | Stale server process on the port | Rebuild, stop the listener, restart, and verify `/api/providers` |
