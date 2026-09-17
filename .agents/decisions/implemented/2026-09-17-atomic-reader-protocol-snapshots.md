---
status: implemented
date: 2026-09-17
decision: Prepare paired reader protocols from one provider snapshot
---

## Context

The reader consumes v2 context/events and native v3 work/coordination together.
A real active Codex route separately reads 773 MB of direct-child evidence for
v2 (3.58 seconds), then 1.23 GB of root/child data for v3 (7.46 seconds). The
v3 builder already constructs its own finalized v2 base. Provider revisions
change between those calls as agents append records, so a latest-revision
adapter cache would still reread and can expose two different observations.

## Decision

Add an optional provider-owned `getSessionProtocolSnapshots` accessor returning
finalized v2 and v3 snapshots from the same input and revision. The reader's
shared runtime resolver uses this capability; other providers continue through
their existing accessors. Canonical reference validation stays in the runtime.
The existing bounded v2 cache can retain the corresponding finalized v3; no
raw provider input or larger transcript cache is introduced.

Codex prepares its existing root and direct-child evidence once and returns
the v2 base alongside the native v3 result. Single-version accessors retain
their existing independent behavior. Appends during construction remain outside
that captured input; a changed revision invalidates the next request rather
than forcing the current pair to mix revisions.

## Alternatives considered

- A latest-revision adapter cache misses while the active family changes.
- Extending a time-based reuse window would hide new evidence.
- Retaining raw protocol input increases large-body lifetime unnecessarily.
- Deriving a v2 snapshot from v3 can include additional v3 events and alter the
  established v2 facts. Preserve the actual finalized base instead.

## Consequences

Only consumers requiring both versions use the optional paired accessor.
Provider errors remain explicit; other providers keep their existing
single-version preparation path. The shared cache stores finalized facts
under the revision captured before construction, so a source change during
construction cannot label older facts as a newer revision. The pair extends
the existing bounded cache entry rather than adding an unbounded input cache.

## Verification

Focused runtime/provider tests verify paired preparation, captured revisions,
cache invalidation, explicit failures and unchanged single-version accessors.
Independent source review and governance/typechecking pass. A stable real
Codex session has identical before/after SHA-256 fingerprints for finalized
v2, finalized v3, owned-reader projection, messages and metrics; both protocols
validate without errors or warnings.

In the real active large-session route, protocol file reads fell from
2,004,578,613 bytes across separate v2/v3 calls to 775,797,365 bytes in one
paired call (about 2.00 GB to 0.78 GB). The paired call took 5.32 seconds;
the complete HTML route measured 20.40 seconds before and 14.27 seconds after.
The source continued growing between observations, so these are non-identical
active-input measurements, not a controlled speed benchmark or completed
long-history responsiveness acceptance. Root message/reader preparation and
initial HTML remain separate costs.

The final integrated suite passes 806/806; seven installed-provider API checks,
site-wide E2E, review and Windows binary smoke pass, including the integrated
keyboard-focus changes. Private evidence
is in ignored `tmp/reader-protocol-fingerprint-{before,after}.log` and
`tmp/reader-protocol-reuse-{before,after}.log`; remaining P9 work is tracked in
[the Reader evidence](../../../docs/design/runtime-acceptance-evidence.md).
