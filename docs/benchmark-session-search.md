# AgentSession MCP search benchmark

`scripts/bench-session-search.mjs` drives the compiled MCP stdio server and
writes one machine-readable JSON result. It records source and compiled artifact
hashes, Node and machine details, startup/index-refresh time, tool discovery,
provider diagnostics, bounded result metadata, wall time, and MCP-process RSS.
The output contains query hashes plus hashes of result keys and match references;
it does not save queries, session identifiers, snippets, or transcript text.
All search calls use one run-level `updatedBefore` snapshot boundary.
Pass the output's `parameters.snapshotUpdatedBeforeUnixMs` through
`--updated-before` on a comparison run to keep that result snapshot fixed.
On Windows it also records MCP-process CPU time and the isolated metadata DB
size after the child process exits.

Run a metadata-only title search across registered providers with two repeated
searches in the same process:

```powershell
node scripts/bench-session-search.mjs --title-query session --title-repeats 2
```

To benchmark one full Codex user/assistant search, pass an explicit query and a
frozen Codex data directory. Two additional same-process scans are available
as an explicit opt-in:

```powershell
node scripts/bench-session-search.mjs --title-query session --title-repeats 2 --codex-query codex --codex-dir 'D:\FrozenCodex' --timeout-ms 120000
```

Add `--codex-repeats 2` to that command for two further Codex scans. The default
is zero Codex repeats; the maximum is two. Use `--file-cache-state likely-warm`
or `likely-cold` to record an operator estimate when the cache state is known.
Use `--codex-pages 10` to request up to ten result pages. Each continuation is
a new full indexed search call, so ten pages may perform ten scans. The JSON
records requested and attempted page/call counts, a page-sequence fingerprint,
and whether the last successful page reached the end. Errors and malformed
results leave the sequence incomplete. Opaque cursors and transcript text are
not saved.

The Codex search is scoped to the Codex provider and runs once by default.
`--codex-query` requires an explicit `--codex-dir`, so the output can identify
the exact corpus. MCP `limit` controls returned page size, not how much provider
data a message search scans; each tool-call timeout bounds its wall time.
Title search uses only recorded titles and includes diagnostics for all five
registered providers. `--title-repeats` is
bounded to five repeats; set it to `0` to skip them. The default output and
isolated `AGENTSESSION_META_PATH` are under the selected checkout's ignored
`tmp/bench-session-search/` directory. `--repo-root` selects the source/build to
fingerprint, and `--cli` selects the compiled MCP executable to launch.
`--codex-dir` passes a frozen Codex data directory to the server and records
before/after hashes of file paths, sizes, and modification times under its
`sessions/` directory. `codexCorpusStatManifestUnchanged` is false if those
stat manifests differ; the run is then partial. This is a stat-manifest check,
not a content hash, so edits that preserve file size and modification time are
not detected. The pre-run manifest walks session directories and stats
transcript files, which may warm filesystem metadata caches before timed
startup. `--meta-path` reuses a derived AgentSession database for an
unchanged restart measurement; it must stay under the selected checkout's
ignored physical `tmp/` tree, without symlink, junction, or hard-link path
components.
`--updated-before` accepts ISO-8601 or Unix milliseconds; it filters which
matches can be returned but does not limit the provider scan.

For a frozen A0 run from another checkout, keep the harness in the working
branch while pointing both options at the clean checkout:

```powershell
node scripts/bench-session-search.mjs `
  --repo-root 'D:\WorkSpace\OpenSession' `
  --cli 'D:\WorkSpace\OpenSession\packages\agentsession-mcp\dist\cli.js' `
  --title-query session --title-repeats 2 --codex-query codex `
  --codex-dir 'D:\FrozenCodex'
```

The harness uses the supported legacy initialize handshake so one measured
server process starts; modern stdio discovery would launch a disposable probe
process and perform another index refresh. `coldProcessAndIndexRefresh.wallMs`
measures process launch through MCP initialization, including config
initialization and the server's initial provider index refresh. The current
stdio interface does not expose the refresh as a separate timed operation.
End-to-end tool wall time and individual provider `durationMs` diagnostics
include derived search-index preparation for content queries.
Each run starts a new server process, while its initial refresh may warm
provider caches before the searches. The host file cache is neither measured
nor cleared. Repeated searches reuse process and host caches, so compare them
separately from the first call.
