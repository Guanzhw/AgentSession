# AgentSession Development Guide

This file is the repository-level source of truth for coding agents and
contributors working on AgentSession. AgentSession names are the only supported
public configuration and runtime interface.

## Project Summary

AgentSession is a local-first, multi-provider viewer for AI coding
sessions. It reads provider-owned session data, builds a cross-provider index,
renders server-side HTML, exposes JSON APIs, and stores viewer-only metadata
such as stars, custom titles, and deletion state in a separate local database.

The package is intentionally small:

- Node.js 22.15 or newer.
- TypeScript compiled as ESM with `NodeNext`.
- No runtime npm dependencies.
- Server-rendered HTML with plain browser JavaScript and CSS.
- Node's built-in test runner.
- Provider adapters for OpenCode, Claude Code, Codex CLI, OpenClaw, Hermes
  Agent, GitHub Copilot CLI, Gemini CLI, Pi, and DeepSeek Harness.

## Non-Negotiable Invariants

### Provider data is read-only

- Do not write to, migrate, delete from, or otherwise mutate provider-owned
  databases and transcript files.
- Viewer state belongs in `src/meta.ts` and the AgentSession metadata
  database.
- "Permanent delete" currently means permanently excluding a session in viewer
  metadata. It does not delete the source session.

### Provider behavior stays provider-owned

- Keep default data paths, resume commands, schema handling, parsing, and
  provider-specific structured views in the provider adapter or provider
  directory.
- Route behavior through `ProviderAdapter` methods and declared capabilities.
  Do not add central `if (provider.id === "...")` branches when a capability or
  optional adapter method can express the behavior.
- Shared provider code under `src/providers/shared/` must be genuinely
  schema-neutral. Keep provider field assumptions in the owning provider.

### Session identity must remain canonical

- Use the provider's canonical session ID throughout URLs, metadata keys,
  exports, resume commands, protocol projections, and session relationships.
- Parsers may normalize raw records, but must not invent a second ID that
  breaks lookup in `getSession()`.
- Metadata keys always include both provider and session ID.

### Structured rendering has stable semantics

- The session detail page groups tools under the assistant turn that produced
  them.
- Reasoning stays attached to the relevant assistant, tool, or subagent output
  and must not cross assistant-message boundaries.
- The table of contents contains user messages, assistant/agent messages, and
  task/subtask entries only.
- Runtime Workbench renders protocol events, work, relationships, and context
  from normalized provider evidence; it must not infer provider semantics in
  browser code.
- Keep HTML structure, `data-*` hooks in `src/views/`, selectors in
  `src/static/app.js`, styles in `src/static/style.css`, and E2E assertions in
  sync.

### System prompt claims must be evidence-based

- OpenCode system prompts are reconstructed from resolvable local sources such
  as `AGENTS.md`, `CLAUDE.md`, configured instructions, agent files, and
  configuration.
- Do not claim to recover hidden provider prompts that are not present in local
  data.
- Preserve source paths and resolution metadata so the UI can distinguish
  resolved content from unavailable content.

### Session Protocol is the runtime inspection boundary

- Every readable provider exposes a finalized, validated Session Protocol v2
  snapshot or an explicit unavailable/invalid diagnostic.
- Preserve recorded versus derived provenance. Missing evidence stays missing;
  do not fabricate tasks, runs, branches, context lifecycle, or child sessions.
- Keep summary, event, and graph projections bounded. Cursor filters are part
  of cursor identity, and graph node limits must also bound construction work.
- Provider-specific event vocabulary belongs in the provider protocol builder.
  Shared runtime projections must not branch on provider id.

### Terminal launch is explicitly trusted local behavior

- Resume launch endpoints are enabled by default for this
  loopback-only local server. `--disable-terminal-launch` disables them for the
  current process.
- Keep launch requests restricted to same-origin JSON requests from loopback.
- Build commands as structured executable/argument/cwd objects. Do not
  concatenate user or session data into an unquoted shell command.
- Provider default resume commands belong on adapters. User overrides belong in
  `resumeCommands` and `resumeShell`.

## Repository Map

```text
bin/
  cli.ts                         CLI entry point; initializes config first
src/
  config.ts                      defaults, CLI/env/config parsing and validation
  server.ts                      loopback HTTP server, routes, APIs, startup index
  db.ts                          OpenCode-compatible SQLite reads
  meta.ts                        viewer-owned stars/titles/deletion metadata
  index-db.ts                    cross-provider startup/search index
  resume.ts                      structured resume command resolution and launch
  protocol-runtime.ts            validated protocol cache and bounded projections
  providers/
    interface.ts                 ProviderAdapter and normalized data contracts
    kinds.ts                     capability helpers
    index.ts                     provider registration
    shared/                      schema-neutral provider helpers
    opencode/                    OpenCode adapter and structured views
    claude-code/                 Claude transcript adapter/parser
    codex/                       Codex JSONL adapter/parser
    openclaw/                    OpenClaw branch-aware JSONL adapter/parser
    hermes/                      Hermes read-only SQLite adapter/parser
    copilot/                     GitHub Copilot CLI event-log adapter/parser
    gemini/                      Gemini JSON adapter/parser
    pi/                          Pi branch-aware JSONL adapter/parser
    deepseek-harness/            DSH multi-frame Zstd adapter/parser/protocol
  views/                         server-rendered page and component templates
  static/                        browser JavaScript and CSS copied during build
  locales/                       English and Chinese UI strings
scripts/
  copy-static.mjs                copies src/static into dist
  qa-agent-browser.cmd           Windows Bash selection wrapper
  qa-agent-browser.sh            live browser/API E2E suite
test/
  core.test.mjs                  parser, provider, config, and render tests
docs/
  CONTRIBUTING-PROVIDER.md       detailed provider contribution walkthrough
dist/                            generated build output; never edit directly
packages/
  agentsession/                  publishable Viewer package assembled from dist
  agentsession-mcp/              publishable read-only stdio MCP server
tmp/, logs/, .agentsession/ runtime and QA artifacts; do not commit
```

## Source And Build Conventions

- Edit `src/`, `bin/`, `scripts/`, `test/`, and documentation. Never patch
  `dist/`; `npm run build` recreates it.
- Use ESM imports and include `.js` in relative TypeScript import specifiers so
  emitted Node ESM resolves correctly.
- Prefer Node built-ins and existing helpers. Adding a runtime dependency
  changes a deliberate project constraint and requires clear justification.
- `tsconfig.json` currently has `strict: false`, but new code should still use
  concrete interfaces and avoid unnecessary `any`.
- Use Unix milliseconds for normalized timestamps.
- Return `null` or empty arrays for unavailable optional provider data when that
  is part of the adapter contract. Do not hide unexpected failures that should
  be diagnosable.
- Handle corrupt individual transcript files defensively so one bad file does
  not prevent the provider from loading.
- Preserve Windows, Linux, and macOS path behavior. Use `node:path`, `node:os`,
  and URL/path helpers rather than manual separators.
- Keep comments focused on non-obvious constraints. Prefer descriptive code over
  narration.

## Architecture And Change Boundaries

### Provider adapters

`src/providers/interface.ts` is the authoritative contract. A provider must
implement detection, data path reporting, scanning, session lookup, normalized
messages, token stats, search, and export. Optional structured views and system
prompt/trace data are adapter methods.

When adding or changing a provider:

1. Update `ProviderId` when adding a new provider.
2. Implement the provider in `src/providers/<id>/`.
3. Declare a provider-owned default `resumeCommand` when the provider supports
   session resume.
4. Declare capabilities instead of relying on provider-name checks.
5. Register the adapter in `src/providers/index.ts`.
6. Normalize IDs, roles, timestamps, token fields, tool input/output, model
   metadata, and parent relationships at the adapter/parser boundary.
7. Add fixtures and tests for current and legacy transcript shapes where
   applicable.
8. Verify unavailable-provider behavior as well as the installed-data path.
9. Update the provider table and `docs/CONTRIBUTING-PROVIDER.md` when the
   contract or supported capabilities change.

Use Gemini as a compact file-provider example, Claude and Codex as linear
JSONL examples, Pi as a branch-tree JSONL example, and OpenCode as the
structured SQLite example. Read the actual adapter before copying a pattern
because provider capabilities differ.

### Server and APIs

- `src/server.ts` uses Node's `http` module and route matching in one request
  handler. Keep route order in mind: API routes are handled before provider page
  routes.
- Provider URLs use `/:provider/...`; APIs use `/api/:provider/...`.
- Validate and safely decode session IDs before lookup.
- Management routes must check `supportsLocalManagement()`.
- Structured metrics and session-tree views must use adapter capabilities or
  optional methods.
- Mutating local settings or launching commands must preserve loopback and
  same-origin checks.
- The server binds to `127.0.0.1`. Do not broaden the bind address without an
  explicit security review.
- Provider availability is indexed and cached at startup. Changes to provider
  paths or startup-only config generally require a restart.

### Configuration

- CLI flags override environment variables and file configuration where
  implemented.
- The default config file is `config.json` under the metadata directory;
`AGENTSESSION_CONFIG` and `--config` select another file.
- `projectPaths`, `resumeCommands`, and `resumeShell` can be applied to a running
  server through the settings API. Data directories, port, and other
  startup-owned settings require restart.
- `allowTerminalLaunch` is startup-only and intentionally ignored from saved
  JSON configuration.
- Update `validateUserConfig()`, settings UI, README examples, and tests
  together when changing the config schema.

### Views, browser code, and localization

- Page structure belongs in `src/views/`; browser-only interaction belongs in
  `src/static/app.js`; visual rules belong in `src/static/style.css`.
- Do not move data interpretation into the browser when the server already has
  normalized provider data.
- Escape untrusted content through existing rendering helpers. Do not insert
  raw provider text into HTML.
- Add or update both `src/locales/en.ts` and `src/locales/zh.ts` for user-facing
  strings.
- For detail-page changes, test long sessions, tool-only assistant turns,
  reasoning placement, nested subagents, and narrow viewport behavior.

### Runtime protocol subsystem

Provider adapters own protocol construction and revision evidence.
`src/protocol-runtime.ts` owns the bounded cache plus summary, event-page, and
graph projections. The Runtime Workbench consumes only those normalized facts.
Update provider fixtures, route tests, list-stat tests, and browser assertions
together when changing this contract.

## Local Development

### Pi helper routing

- When Pi is explicitly requested but high-level Pi tools are not in the
  explicit tool list, search the deferred catalog for `mcp__pi_wsl__*` before
  falling back to raw WSL commands.

Install dependencies:

```powershell
npm install
```

Useful commands:

```powershell
npm run typecheck  # TypeScript check without emitting files
npm run build      # Compile TypeScript and copy static assets
npm test           # Build, then run all Node tests
npm start          # Build, then start on 127.0.0.1:3456
npm run dev        # Build, start, and open the browser
```

Tests import compiled files from `dist/`, so use `npm test` for the normal
suite. For a focused iteration, build first and then use Node's test-name
filter:

```powershell
npm run build
node --test --test-name-pattern="runtime protocol" test/protocol-runtime.test.mjs
```

Use real provider data for final verification when the change depends on
provider schemas, path detection, nested sessions, token accounting, or browser
rendering. Fixtures alone are not enough for those changes.

## Validation Matrix

Choose validation based on the affected surface:

| Change | Minimum validation |
|:---|:---|
| Documentation only | Re-read changed sections; verify commands, paths, links, and names |
| Types/config/helper code | `npm run typecheck` and relevant focused tests |
| Provider/parser/schema | `npm test` plus a real-data adapter or page check |
| Server/API/meta/index | `npm test`, restart, and direct API checks |
| Views/static/locales | `npm test`, restart, and `npm run qa:e2e` |
| Resume/terminal launch | Tests plus a real descendant-process launch check |
| Session Protocol/runtime | `npm test`, real provider/API checks, and browser QA |
| Cross-provider/refactor | Full build/test/E2E and unavailable-provider coverage |

## Restart AgentSession

Run these commands from the repository root after server-affecting changes.

### 1. Build

```powershell
npm run build
```

### 2. Find and stop the listener on port 3456

PowerShell:

```powershell
$listeners = Get-NetTCPConnection -LocalPort 3456 -State Listen -ErrorAction SilentlyContinue
$listeners | Select-Object LocalAddress, LocalPort, OwningProcess
$listeners | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

Git Bash alternative:

```bash
netstat -ano | grep :3456
pwsh -C 'taskkill /F /PID <PID>'
```

Do not use `$pid` as a PowerShell loop variable; `$PID` is a read-only built-in.

### 3. Start in the background

PowerShell:

```powershell
Start-Process -FilePath node `
  -ArgumentList "dist/bin/cli.js" `
  -WorkingDirectory (Get-Location) `
  -RedirectStandardOutput "app.log" `
  -RedirectStandardError "app-error.log" `
  -WindowStyle Hidden
```

Git Bash alternative:

```bash
node dist/bin/cli.js > app.log 2>&1 &
```

For the normal resume launch path, start without an extra launch
flag. Add `--disable-terminal-launch` when testing the opt-out path.

### 4. Verify

```powershell
Get-NetTCPConnection -LocalPort 3456 -State Listen
Invoke-RestMethod http://127.0.0.1:3456/api/providers
```

Inspect `app.log` and `app-error.log` if startup or indexing fails.

## Repeatable E2E QA

The QA suite assumes a compatible server is already running. It checks the
dashboard, search, statistics, settings, detail rendering, exports, Runtime, and
terminal-launch-disabled behavior.

```powershell
$env:AGENTSESSION_QA_BASE_URL = 'http://127.0.0.1:3456'
$env:AGENTSESSION_QA_SESSION_ID = '<real-session-id>'
npm run qa:e2e
```

Set `AGENTSESSION_QA_SESSION_ID` to a real OpenCode session that includes
reasoning, tools, tokens, and subagent activity. It is intentionally required:
the repository does not embed a machine-specific session ID.

On Windows, `npm run qa:e2e` calls `scripts/qa-agent-browser.cmd`, which selects
Git Bash or Cygwin Bash. If Bash is elsewhere:

```powershell
$env:AGENTSESSION_QA_BASH_PATH = 'C:\path\to\bash.exe'
```

The script uses `tmp/npm-cache` to avoid global npm cache permission issues and
cleans up its browser session. A transient browser transport timeout should be
retried once before being classified as a product regression.

## Working Tree And Documentation Hygiene

- Check `git status --short` before editing and before reporting completion.
- Preserve unrelated user changes. Do not reset or rewrite files outside the
  requested scope.
- Do not commit generated `dist/`, runtime databases, logs, screenshots, or QA
  output.
- Keep `README.md`, `README.en.md`, CLI help, settings labels, and examples in
  sync when changing user-visible behavior.
- `origin` and the publish remote may not refer to the same repository. Inspect
  `git remote -v` before fetch, rebase, or push operations.
- Prefer source and tests over old prose when documentation disagrees with
  current behavior, then update the stale documentation in the same change.

## Completion Checklist

Before declaring a development task complete:

1. Confirm the implementation respects provider ownership and read-only source
   data.
2. Add or update focused regression tests.
3. Run the validation level required by the matrix.
4. Restart and exercise the live app when behavior is user-visible.
5. Check browser/API output, server logs, and protocol validation diagnostics.
6. Review `git diff --check` and `git diff`.
7. Update relevant README, config, provider, and architecture documentation.
8. Report commands run, exact results, and any verification that could not be
   completed.
