# AgentSession

AgentSession 3.0 is a local-first reader for AI coding work history. The sole
implementation in this workspace uses Rust, Axum, native rmcp stdio MCP, and a
Svelte frontend. It reads OpenCode, Claude Code, Codex CLI, Pi, and DeepSeek
Harness sessions into the Library, Reader, search, statistics, and Runtime views.

Provider databases and transcripts remain read-only. Stars, titles, and Viewer
Trash use separate metadata. Canonical provider/session identity and recorded
evidence remain visible throughout the reading and MCP flows.

[中文](README.md) · [Native CLI, configuration and MCP](v3/README.md) ·
[Acceptance contract](docs/design/agentsession-v3-acceptance-contract.md)

## 3.0.1 stable release candidate

**3.0.1** is prepared for stable publication to npm's `latest` channel. The
[release notes](docs/releases/3.0.1.md) describe fixes, migration and actual
validation scope. Final integrated CI and public publication checks are pending.
Complete performance/resource acceptance and historical state attribution retain open items in the [ledger](docs/specs/stable-readiness-2026-10/tasks.md).

```sh
npm install -g @acetamido/agentsession@3.0.1
npm install -g @acetamido/agentsession-mcp@3.0.1
agentsession
```

Prereleases retain npm's `next` channel. [Release and upgrade notes](docs/releases/3.0.0.md)
compare it with public v1.10.1, including the port change, metadata-copy import,
and MCP/API migration. The published 3.0.0 standalone bundles are available in the
[GitHub Release](https://github.com/Guanzhw/AgentSession/releases/tag/v3.0.0).
The pinned installation commands above apply once 3.0.1 is published.

When upgrading, follow the [metadata migration guide](v3/README.md#viewer-metadata-import)
before editing stars, titles or Trash in the new Viewer. The 3.0.0 npm entrypoint
supports `migrate-meta`; the guide also retains the rc.4 standalone path and
explains how to preserve both states if 3.0 metadata already exists.

If a third-party npm mirror returns `404` for a newly published tarball, select
the official registry for that installation:

```sh
npm install -g @acetamido/agentsession@3.0.1 @acetamido/agentsession-mcp@3.0.1 --registry https://registry.npmjs.org
```

This leaves the global npm registry configuration unchanged. If the official
registry also fails, retain its specific error for diagnosis.

## Run from source

Development requires Node.js 22.15 or newer and Rust with edition 2024 support.

```bash
npm install
npm --prefix v3/ui ci
npm run build
npm start
```

Open [the local Viewer](http://127.0.0.1:3457). Root installation has no prepare
build. UI installation is explicit; `npm run build` builds the UI and locked
Rust release. `npm start` builds and starts that native Viewer. Forward options
with `npm start -- --port 3458 --disable-terminal-launch`.

For the already-built binary, run `v3/target/release/agentsession-v3 serve`
(`.exe` on Windows), or use its `mcp` subcommand for native stdio MCP.
Standalone binaries need neither Node nor Cargo at runtime.

## 3.0.0 reading and navigation fixes

Content-search links reveal and highlight matches beyond the initial Reader
window using UTF-16 positions and `contentRevision`, with bounded body retrieval.
Browser Back restores the query, results and selected position. Library rows show
their own star state; **Only starred** combines with provider, project, time and
sort filters while retaining the core's parent/child family semantics.

After a **Technical details** source link opens the conversation, Back restores
the Runtime view, applied filters, current page and scroll position. Related
session graph selection also survives history navigation. Trash distinguishes
complete, partial and failed reads: partial results keep readable rows and mark
the count incomplete; failed reads report an unknown count. Both offer retry.
Source issues link to the matching Settings anchor with the current startup
path, configuration field, CLI option and restart/recheck instructions. Path
precedence is CLI, environment, configuration file, then provider defaults.

See the [repair specification](docs/specs/reader-journey-repair-2026-10/requirements.md)
and [execution record](docs/specs/reader-journey-repair-2026-10/tasks.md) for scope
and actual validation. These changes are included in 3.0.0; historical rc.4
retains its recorded behavior.

## Development and status

The 3.0.1 release candidate defaults Statistics trends, Harness comparisons and
model shares to tokens. Codex ordinary `token_count` records contribute verified
cumulative increments to known usage; repeated snapshots add nothing. Request
counts still require request identity. Legacy `session_id` headers are also
discoverable. See the [statistics decision](.agents/decisions/implemented/2026-10-12-codex-recorded-token-consumption.md).

The 3.0.1 architecture repairs also correct Claude pending-usage deduplication,
retain ambiguous DSH sessions as diagnostic rows, and preserve captured
Protocol errors in the Reader. Older derived indexes and Reader caches are
recaptured automatically; provider records and Viewer metadata are preserved.
Public browser regressions are required in Linux x64 CI. Browser tools have
their own installation, retaining the project's Node.js 22.15 development floor.

```bash
npm run review
npm test
```

See [the development guide](AGENTS.md) for ownership and validation, and the
[delivery plan](docs/design/agentsession-v3-delivery-plan.md) for remaining
source, performance, product, and platform gates. The 3.0.1 notes identify the
validation scope and pending publication checks; unresolved acceptance items remain open. Historical 2.0
evidence and migration decisions retain their original scope; its implementation
can be recovered from Git history.

## License

MIT
