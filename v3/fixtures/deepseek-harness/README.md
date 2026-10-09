# S2 DeepSeek Harness public synthetic source

This fixture is entirely synthetic. It is **not real-team evidence**. It tests
the released DSH v3 event shapes recognized by the native
[adapter](../../crates/core/src/providers/deepseek_harness.rs). The current
adapter discovers `session.v3.jsonl.zstd`; `.jsonl.zst` is not a recognized DSH
session filename. Regenerate with
`node v3/fixtures/deepseek-harness/build-synthetic.mjs`.

All three sources live under `sessions/s2-synthetic/<canonical-id>/` and each
contains two independent, concatenated Zstandard frames. Each frame ends on a
JSONL record boundary. The source-fact test decodes the two frames separately;
Node's single `zstdDecompressSync` call only returns the first frame.

| Canonical session ID | Source records | Bytes | SHA-256 |
| --- | ---: | ---: | --- |
| `dsh-v3-s2-root` | 29 (header + seq 0–27) | 1903 | `ff0e1515e0faac0b0e0a44515afcd484896fae748d9164931b0cde981782880f` |
| `dsh-v3-s2-alpha` | 8 (header + seq 0–6) | 650 | `4d139be50bd2121c454b92176e689fac3ba901347d3b06106b6c49a15924a51e` |
| `dsh-v3-s2-beta` | 8 (header + seq 0–6) | 646 | `c38d044b4e05a264ac02082cce4e209fac6da7503468ae48bfd7b7a5a4db9e96` |

## Independent source facts and expected behavior

These expectations come from explicit records and IDs in the binary sources,
not from Viewer output. [`dsh-s2-fixture-facts.test.mjs`](../../test/dsh-s2-fixture-facts.test.mjs)
checks the source facts without importing the DSH adapter or Rust core.

| Root source seq | Recorded fact | S2 expectation |
| ---: | --- | --- |
| 1, 3 | `root-user`, then `root-dispatch` | Reader order and canonical message refs retain these IDs. |
| 4–7 | Members `dsh-v3-s2-alpha` and `dsh-v3-s2-beta`; team tasks `alpha` and `beta` at revision 1, `in_progress` | Two assignments remain distinct, linked to the exact child IDs. |
| 8–13 | Initial queued/delivered messages; workflow `parallel-inspection:1` for alpha and `:2` for beta start | Dispatch and delivery are separate recorded observations. Both children are linked at their parent-side start points. |
| 14–16 | `root-continues`, then a second alpha message `mail-alpha-followup` queued and delivered | The parent mainline continues while work is active; the follow-up stays with alpha and retains its own content. |
| 17–22 | Beta then alpha workflow completion and task revision 2; alpha-to-parent `mail-alpha-return` queued and delivered | Completion and return are independently visible. Workflow completion order is beta, then alpha; returned content remains reachable. |
| 23–25 | `root-check` call/result with `SYNTHETIC-MARKER-OK`, then `root-final` ending `END-OF-SYNTHETIC-DSH-ROOT` | Tool call/result use one call ID; Reader and MCP can locate the result and continue the final body to its ending marker. |
| Child seq 4 | `alpha-answer` and `beta-answer` | Opening each child shows its own answer and the `ALPHA-END` or `BETA-END` marker; child content is not counted as a parent-owned message. |

The expected public session refs are `deepseek-harness` plus the canonical IDs
above. The expected event refs include `root-final` / `message` and `root-check`
/ `tool`; no alternate ID is needed. A test should traverse both child sources
from the parent, open the parent-side dispatch/follow-up/return observations,
page the final body to its exact ending marker, and compare Web and MCP facts
from one source revision. This supplies RED input for **CORE-07**, **CORE-11**,
and **WEB-04**. CORE-06 in the acceptance contract concerns OpenCode.

The old parser/protocol can validate these source shapes, but that does not
establish 3.0 Web, Reader, MCP, browser, release, or real DSH team acceptance.
The S2 gate also requires a separate frozen real compressed DSH session. The
native team/workflow real-data gap remains open for S4.
