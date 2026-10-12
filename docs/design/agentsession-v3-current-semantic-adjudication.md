# Current candidate semantic adjudication

Updated: 2026-10-12. This records the source interpretation used to validate
the stable candidate, following the existing
[performance protocol](agentsession-v3-performance-protocol.md). Complete raw
responses retain their fields and array order. Known contract differences have
explicit source evidence; their timings remain descriptive rather than an
equal-output speed comparison.

## Search navigation targets

The current search response adds `target`: a canonical event, content field,
original UTF-16 offset and match length, and the normalized body revision.
These fields support the Library-to-Reader navigation repair. The first shared
resource attempt failed against the historical whole-object search hash.

An independent source interpreter then streamed and checked all 816 frozen
Codex files. It derived 813 targets for the fixed shared query, three nonmatches
and zero unresolved sources. Every target from Web and both MCP processes
matched the derived event, body revision and span. The 810 fixed-cutoff results
also retained the exact historical order, count and every pre-existing field.

The revised comparison requires the entire target and existing event to match
the raw-source oracle before comparing all remaining fields with the unchanged
historical gold. Full current responses remain in the raw evidence and are
compared across processes. The original failed attempt remains failed; the
revised oracle uses a new controller binding and run identity.

## Full session summaries

The independently selected parent and its 18 children account for every
previously unexplained summary difference. The parent contains 515 distinct
source-proved response IDs, totaling 66,056,398 tokens. The old total of
135,895,655 is reproduced by adding canonical and anonymous usage rows with
only adjacent mirror suppression. A recorded tool result can separate a
request from its matching legacy observation, leaving both in that old sum.
Anonymous observations continue to be retained as evidence.

The source also accounts for the different count units. The old 673-message
total comprises six user messages, 55 assistant bodies, 105 reasoning units
and 507 tool calls. The current 163 rendered groups include 31 recorded child
replies; excluding those replies gives 142 conversation groups. Ten child
replies share an existing producing group. The old assistant role count of
160 and current count of 191 differ by those recorded replies.

All 18 child summaries were independently recounted. Four token totals remain
unknown because copied parent metadata conflicts with the child request owner.
This follows the accepted
[usage provenance decision](../../.agents/decisions/implemented/2026-09-29-v3-codex-unresolved-usage-observations.md):
an explicit thread ID alone does not override the active metadata owner. The
two versions' child arrays contain the same identities but use their declared
different ordering contracts.

A fresh final5 native MCP call over verified copies of all 19 sources matches
the current counts, usage ownership and ordering. Its 19 added `durationMs`
values agree with raw-source first/last visible conversation timestamps.
Sources remain byte-identical and the process exits normally. The complete
fixed2/current responses have 118 differing paths, all retained and explained;
complete-output speed comparison remains ineligible.

## Evidence and qualification

The current Windows executable SHA-256 is
`0b18b773e5baab92746c5d04d45ac88e7863d8830b664235502da0bb5ee92114`,
with production source at `11ec33d57762b96c752473a5b4a8a69e961d7742`.
Private raw records, per-source hashes, line anchors, exact response diffs and
cleanup evidence are under
`tmp/stable-readiness-20261011/full-get-adjudication/`. The shared target oracle,
frozen original comparator and revised policy are under
`tmp/stable-readiness-20261011/resource-validation/comparison-v2/` and
`comparison-v1-sealed/`.

This adjudication establishes the selected semantics. Resource repetitions,
remaining workloads, absolute latency thresholds and state-preservation
outcomes retain their separate checks in the
[stable task ledger](../specs/stable-readiness-2026-10/tasks.md).
