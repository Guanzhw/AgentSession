# Execution and evidence

Updated: 2026-10-11. Requirements: [requirements.md](requirements.md).
Design: [design.md](design.md).

## Work packages

| Work | Requirements | Owner | Status |
| --- | --- | --- | --- |
| Freeze scope and acceptance | All | Orchestrator | Complete |
| npm command routing and installed migration regression | UPG-01/02 | CLI worker | Complete; installed RED then GREEN |
| Explicit private-source test opt-in | VAL-01 | Validation worker | Complete; default ignored and missing-input failure checked |
| Reconcile actual release/platform status | DOC-01/GATE-01 | Evidence worker | Complete; exact-tag runs checked and remaining gates retained |
| Operational upgrade guide and mirror troubleshooting | UPG-03/DOC-02 | Orchestrator | Complete; published rc.4 and unreleased behavior separated |
| Integrated tests and installed-artifact verification | UPG-01/02, VAL-01 | Orchestrator | Complete on Windows x64; results below |
| Independent review and final diff | All | Independent reviewer + orchestrator | Complete; no actionable P1/P2 findings |

## Starting evidence

- Working tree was clean. The previous audit installed the public rc.4 packages
  from the official npm registry in ignored `tmp/release-audit-20261011`.
- The installed Viewer reports rc.4; `migrate-meta --help` exits 2 because the
  wrapper inserts `serve`. This is the observed failing behavior for UPG-01.
- The default local npm mirror returned a native tarball 404; an explicit
  `--registry https://registry.npmjs.org` installation succeeded.
- Exact rc.4 publication run
  [38132614812](https://github.com/Guanzhw/AgentSession/actions/runs/38132614812),
  Quality [38132610988](https://github.com/Guanzhw/AgentSession/actions/runs/38132610988)
  and native validation
  [38132610982](https://github.com/Guanzhw/AgentSession/actions/runs/38132610982)
  were read as successful in this chat. Recheck before recording current status.

## Verification results

### Implementation regressions

- UPG-01 RED: the installed regression's explicit `serve --help` exited 2 with
  `unexpected argument 'serve'` before the wrapper repair. The earlier actual
  public npm install also rejected `migrate-meta --help` with exit 2.
- UPG-01/02 GREEN: an actual pack/install using the repaired Viewer and the
  selected rc.4 Windows runtime passed migration of a task-owned SQLite copy,
  source/target hashes, refused repeat import, HTTP title/star values, global
  config placement, default/option-only/explicit Viewer invocation and both
  independent/explicit MCP entrypoints. The SDK initialized and read the tool
  surface; the existing standalone MCP content read remained covered.
- VAL-01 RED: absent Pi manifest and unset Claude manifest each produced
  `1 passed, 0 ignored` before the repair. Afterward, each default filtered run
  produced `0 passed, 1 ignored`; explicit `--ignored` runs without the required
  manifest failed with exit 1 and a prerequisite message. Existing full source
  traversal and hash assertions remain intact.

### Integrated commands

`npm run review` passed governance, Rust formatting and locked workspace
compilation. `cargo test --workspace --manifest-path v3/Cargo.toml --locked`
passed 237 core tests and 5 app tests, with 18 explicitly ignored tests and zero
failures. The two new ignored results explain the change from the previously
reported 244 passed / 16 ignored; they do not establish new private-source
coverage.

The selected portable bundle was created with:

```powershell
node scripts/v3-package-portable.mjs --release-bin tmp/release-audit-20261011/node_modules/@acetamido/agentsession-native/bin/win32-x64/agentsession-v3.exe --output-dir tmp/npm-upgrade-followthrough-bundle
```

The orchestrator then ran:

```powershell
$env:AGENTSESSION_V3_BIN = (Resolve-Path tmp/release-audit-20261011/node_modules/@acetamido/agentsession-native/bin/win32-x64/agentsession-v3.exe).Path
$env:AGENTSESSION_V3_NPM_CANDIDATE = '1'
$env:AGENTSESSION_V3_NPM_HOST_BUNDLE = (Resolve-Path tmp/npm-upgrade-followthrough-bundle).Path
node --test --test-concurrency=1 v3/test/meta-migration.test.mjs v3/test/npm-candidate-install.test.mjs v3/test/npm-native-targets.test.mjs
```

Result: **11 passed, 0 failed, 0 skipped**, including committed-WAL metadata
import, scope isolation, rejection of an incompatible database, target mapping
and actual offline Windows package installation. Processes and temporary state
belong to each test. The public fixture and legacy input bytes remain unchanged.

### Evidence scope and remaining work

The local pre-existing `v3/target/release` binary reported `3.0.0`; the packager
correctly rejected it against the rc.4 package version. Validation instead used
the original rc.4 Windows binary from the preceding official-registry install,
in a new owned bundle. No production Rust or UI code changed; the new package
contains the updated launcher and documentation. Other hosts have rc.4 baseline
CI evidence, not execution evidence for this subsequent wrapper change.
The selected Windows runtime SHA-256 is
`0b3005a0e4d4ce993c4a5c3b8cf3f9231bef298c4714484cc93ac97abecdefa5`.
The orchestrator's checks ran on Windows x64 with Node.js `26.5.1` and Rust
`1.93.1`; npm's declared minimum Node version was not re-tested in this patch.

The old Pi manifest was absent both at its former workspace location and in the
bounded archive lookup. Two historical Claude directories contained JSONL files
but no matching manifest or recorded snapshot hash. They were not relabeled as
verified frozen samples. Private-source opt-in tests therefore remain unexecuted
with real data in this follow-through; the documented prerequisites are required.

The [stable-release gate table](../../design/agentsession-v3-delivery-plan.md#稳定版剩余门槛)
owns remaining real-source, end-to-end/resource, human-feedback and historical
state-attribution work. This patch does not close those gates or modify
published rc.4 artifacts.

### Independent review

A fresh-context reviewer inspected the requirements, full diff, owning native
CLI and metadata code, installed-test assertions and exact GitHub job evidence.
The review found no actionable P1/P2 issue. The orchestrator separately inspected
the final diff and ran the integrated checks above. Final governance and
`git diff --check` pass. Changes remain local and unreleased; publication and
the remaining stable-release gates are separate work.
