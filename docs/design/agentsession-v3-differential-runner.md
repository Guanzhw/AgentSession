# AgentSession 3.0 differential runner

The S1 runner starts a fixed 2.0 Web command and a candidate 3.0 Web command in
sequence. Each must answer `GET /api/providers` on its own loopback port. It
then runs the **same** private [capture plan](../../scripts/v3-capture-contract.mjs)
against each endpoint and, when the plan has MCP cases, launches each side's
specified stdio MCP command. The existing
[snapshot comparator](../../scripts/v3-compare-snapshots.mjs) checks exact JSON
semantics, including case and array order. Only fields approved in the explicit
[volatile policy](agentsession-v3-volatile-policy.json) may differ without
failing. Exit codes are 0 for a match, 1 for a semantic difference, and 2 for
configuration, capture, or comparison error.

Keep the plan, frozen source copy, corpus manifest, and output under this
checkout's ignored `tmp/`. The runner requires distinct 2.0 and 3.0 ports and
six separate state directories outside the frozen source root. Each Web command
must reference `${PORT}`, `${CORPUS_ROOT}`, `${META_DIR}`, `${INDEX_DIR}`, and
`${CACHE_DIR}` in its arguments or environment. MCP commands must reference the
four source/state placeholders. Paths and commands remain explicit in the
private plan so a reviewer can audit the actual binaries and configuration.
For example, a plan has this shape, with absolute paths substituted locally:

```json
{
  "format": "agentsession-v3-differential-plan/v1",
  "corpus": {
    "root": "<checkout>/tmp/v3-corpus",
    "manifest": "<checkout>/tmp/v3-corpus/manifest.private.json",
    "manifestSha256": "<64 lowercase hex digits>"
  },
  "capturePlan": "<checkout>/tmp/v3-corpus/capture-plan.private.json",
  "volatilePolicy": "<checkout>/docs/design/agentsession-v3-volatile-policy.json",
  "mcpEra": "modern",
  "sides": {
    "v2": {
      "port": 3467,
      "state": { "metaDir": "<checkout>/tmp/v3-run/v2-meta", "indexDir": "<checkout>/tmp/v3-run/v2-index", "cacheDir": "<checkout>/tmp/v3-run/v2-cache" },
      "web": { "command": "<absolute executable>", "args": ["<absolute entrypoint>", "--port", "${PORT}"], "cwd": "<absolute checkout>", "env": { "CORPUS": "${CORPUS_ROOT}", "META": "${META_DIR}", "INDEX": "${INDEX_DIR}", "CACHE": "${CACHE_DIR}" } },
      "mcp": { "command": "<absolute executable>", "args": ["<absolute MCP entrypoint>"], "cwd": "<absolute checkout>", "env": { "CORPUS": "${CORPUS_ROOT}", "META": "${META_DIR}", "INDEX": "${INDEX_DIR}", "CACHE": "${CACHE_DIR}" } }
    },
    "v3": { "port": 3469, "state": { "metaDir": "<checkout>/tmp/v3-run/v3-meta", "indexDir": "<checkout>/tmp/v3-run/v3-index", "cacheDir": "<checkout>/tmp/v3-run/v3-cache" }, "web": { "command": "<absolute executable>", "args": ["<entrypoint>", "${PORT}"], "cwd": "<absolute checkout>", "env": { "CORPUS": "${CORPUS_ROOT}", "META": "${META_DIR}", "INDEX": "${INDEX_DIR}", "CACHE": "${CACHE_DIR}" } }, "mcp": { "command": "<absolute executable>", "args": ["<entrypoint>"], "cwd": "<absolute checkout>", "env": { "CORPUS": "${CORPUS_ROOT}", "META": "${META_DIR}", "INDEX": "${INDEX_DIR}", "CACHE": "${CACHE_DIR}" } } }
  }
}
```

The shown environment names are illustrative; use the actual version's CLI
flags and variables. A complete local plan must wire **all five provider roots**
to the same frozen copy on both sides. The runner verifies the manifest file's
SHA-256, every listed frozen source file's SHA-256 before, between, and after
the two runs, and the source/state directory separation. The reviewer must
verify that the manifest inventories the intended source files and that each
command actually uses the declared paths. A private plan can include both
HTTP and MCP cases.

```powershell
node scripts/v3-run-differential.mjs --config D:\...\OpenSession\tmp\v3-run\plan.private.json --report D:\...\OpenSession\tmp\v3-run\summary.private.json
```

The JSON summary contains the configuration, manifest, capture-plan, policy,
snapshot, and comparison SHA-256 digests, capture byte counts, comparison exit
code, and semantic/ignored difference counts. Full snapshots, command logs,
and the comparator's per-path report stay beside the summary in ignored `tmp/`.
Console output contains only status and counts. The runner is a comparison
tool; source-backed golden checks, full Reader navigation, real MCP host calls,
and the matched performance protocol remain separate S1/S4 evidence.
