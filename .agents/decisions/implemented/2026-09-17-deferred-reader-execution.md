---
status: implemented
date: 2026-09-17
decision: Defer folded tool-process DOM while preserving canonical reader sources
---

## Context

The real long Codex reader still generates roughly 23.7 MB of HTML and 225,445
elements after folded tool fields were deferred. Tool panels account for most
of that hidden markup. Separate profiling identifies provider record parsing
as the dominant server cost; reducing DOM does not establish faster parsing.

## Decision

Defer tool-only execution bodies at the existing reader disclosure boundaries,
in chunks of at most 20 tools. Keep canonical source anchors in lightweight
placeholders and load a chunk in place when opened or targeted by search or a
source link. Stable message and first/last part IDs identify each chunk. The
server owns grouping, reasoning attachment, status and markup; the browser
loads and scopes the fragment within its existing owning pane.

Readable message bodies, local runtime milestones, checkpoints, and child
session entry points remain available on the initial page. The complete
source search and field continuation APIs retain their existing semantics.
Source navigation waits for its chunk and does not turn a network failure
into a claim that the recorded source is absent.

## Alternatives considered

- Deferring every folded commentary block would widen the change to child
  opener recovery and message grouping. Start with tool execution bodies.
- Hidden templates retain transfer and parsing costs; use server fragments.
- A generic virtual-list or new provider/protocol projection is unnecessary
  for the existing normalized reader consumers.

## Consequences

Expanding an unloaded process performs a read-only request; failures leave a
retryable placeholder. Loaded content and positions survive pane navigation.
Canonical anchors and child-pane ID scoping must work for late fragments.
Search-triggered loading must not cancel its own reveal operation.
An existing chunk URL retains its original last part when new tools append to
the same message. Invalid or changed boundaries remain explicit failures.
When runtime evidence is unavailable during initial rendering, tools retain
their directly rendered form alongside the existing runtime diagnostic.

## Verification

- `npm test`: 795/795; full live `qa:e2e`, seven installed-provider API samples,
  and Windows binary build/smoke pass. Actual chunk endpoints were exercised
  with Codex, DeepSeek Harness and OpenClaw records; the other samples do not
  contain eligible ordinary tool chunks.
- Real browser checks cover canonical hash loading, complete-source search
  into a later field page, failed process load/retry, scoped child fragments,
  keyboard focus, parent search restoration and 390px containment.
- A stable real session preserves all 48 prose bodies byte-for-byte and all
  408 message/part anchors in order. HTML falls from 1,647,042 to 1,368,844 bytes;
  elements fall from 13,004 to 9,232.
- The active long history falls from 23,745,775 to 14,252,388 HTML bytes and
  225,445 to 114,421 parsed elements. All previous prose hashes and canonical
  anchors remain, in anchor order; additional records arrived between samples.
  HTTP generation still takes about 14.2 seconds, so this is a markup reduction,
  not evidence that provider preparation or end-to-end latency is resolved.
- Independent client and server review found focus stealing during a pending
  request and stale last-part handling after append. Both are fixed and covered
  by regressions; the main agent inspected the final diff and live behavior.
