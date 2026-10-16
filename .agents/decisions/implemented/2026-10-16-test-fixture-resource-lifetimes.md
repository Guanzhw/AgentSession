---
status: implemented
date: 2026-10-16
decision: Register Node test fixture disposal at acquisition and release dependent resources in reverse order before removing their directories.
---

## Context

Issue #1 originally identified temporary fixtures in the retired TypeScript tests.
The 3.0 audit found 67 OS temporary-directory creation sites in 51 native test
files. The host installer retained fixtures after successful tests; setup and
assertion failures left directories or open SQLite handles. Node test after
hooks run in registration order, so an early directory hook could run before a
later MCP client hook. These failures were reproduced on Windows.

## Decision

The test-only `test/helpers/fixture-cleanup.mjs` owns one disposal stack per test
context. Directory helpers register removal immediately after creation. Later
acquired clients, processes, HTTP/Vite servers, and browsers register their
disposal on the same stack. Teardown runs in reverse acquisition order and
reports all cleanup errors while continuing the remaining actions.

Short-lived SQLite fixture writers keep lexical `try/finally` blocks. Source
integrity assertions have their own cleanup actions so a failed assertion cannot
prevent directory removal. Tests continue to use their original source fixtures
and isolation paths; provider-owned records remain read-only.

## Alternatives considered

Registering a directory's normal after hook earlier fixes setup leaks but keeps
FIFO ordering relative to clients and servers. Repeating an entire resource
lifetime block in every harness makes the same ordering bug easy to reintroduce.
The shared stack addresses the audited consumers; ordinary lexical `finally`
remains appropriate when one function owns the whole lifetime.

## Consequences

The helper is test infrastructure and changes no product API or provider
behavior. Existing tests retain their assertions and conditional corpus gates.
Cleanup failures are test failures, and a failing test still releases its owned
resources. Historical fixtures are separately inventoried and moved only from a
reviewed exact allowlist into a recoverable local quarantine.

## Verification

Windows reproduction and reruns covered the installer success leak, settings
write failure, SQL setup failure, metadata assertion failure, Vite build/create
failure, and dependent HTTP/SQLite resource disposal. The added regression suite
checks fixture absence before its independent outer sandbox is removed.

The two affected browser groups executed 47 and 71 tests with no failures or
skips. The 13 root fixture files passed twice (100 passed, one unavailable-corpus
skip per run); both deliberate root failure runs preserved the original errors
and left no temporary fixtures. Native CI executes the cleanup regressions
alongside the packaged test suite on all four declared platforms.
