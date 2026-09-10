---
status: implemented
date: 2026-09-11
decision: Expose recorded DSH approval audit detail and current open-turn ask references through the shared Session Protocol boundary.
---

# Recorded approval destination

## Context

DeepSeek Harness records approval asks and decisions as log-only events. The
existing parser mapped their kind and correlation but discarded their readable
fields, while status needed to distinguish an unmatched ask in the current
open turn from resolved approvals in completed turns.

## Decision

The shared protocol carries optional typed `ApprovalEventDetail` on event
envelopes and optional canonical `pendingApprovalEventIds` on the session
descriptor. DSH folds owned records once per protocol build, resetting the
approval map at each turn boundary; the same lifecycle supplies status and
current refs. Its event IDs use the existing `event:dsh:<source-seq>` identity.
The public event projection includes the typed detail while continuing to
exclude provider payloads. V2 and V3 retain the same normalized event facts.
The shared validator requires every non-empty pending set to agree with
`waiting_input`, and every referenced ask to carry a non-empty correlation ID
so a bounded Events destination cannot silently fall back to the first page.

## Alternatives considered

- Read raw provider payloads in the browser: typed event details keep provider
  interpretation at its adapter and support the existing public event API.
- Treat approval audits as conversation messages: upstream records them as
  log-only evidence, so the existing Events destination preserves their meaning.

## Evidence

The shape is derived from official DSH commit
`b2e3b2a0125854567a4a5fcba75782e42fe84901`,
`packages/interaction/user-approval/src/types.ts` and
`packages/interaction/user-approval/src/invariant.ts`. The source defines
`approval/asked` (`id`, `toolName`, optional `callId`/`reason`) and
`approval/decided` (matching `id`, `outcome`) as log-only events within an
open turn.

## Consequences

Resolved and terminal approval history remains readable in Events but cannot
become current pending work. Providers without current approval evidence omit
the descriptor field; DSH emits an explicit empty list when its owned fold has
no unmatched ask. The Workbench can link a current ref to the canonical event
and existing correlation filter without inventing a task or conversation
message; malformed refs remain explicit protocol validation failures.

## Verification

Main-agent `npm test` passed 559/559; `npm run review` passed governance and
typechecking. Restarted real Codex, OpenCode and DSH protocol APIs validated;
DSH's completed session exposed empty current refs while other providers omitted
the unsupported field. Real OpenCode E2E passed with no browser errors.

A labelled in-memory DSH fixture reached two distinct current asks after more
than 100 events through the production query/filter and drawer. Full reasons
stayed escaped and expandable. EN/ZH, light/dark and 1280/768/320 checks passed;
keyboard activation and Escape focus return passed. Attention axe audits passed
in both themes. Positive pending evidence is fixture-backed; no live pending
approval was available.

## UI realization

The Workbench consumes only validated v3 current approval refs and resolves
their canonical asked events, bounded to three compact shortcuts. Each entry
keeps the recorded tool, optional call ID and reason, with long reasons behind
a disclosure, and reuses the existing Events tab correlation filter. The
Events drawer renders the typed approval fields directly; it does not parse
provider data or promote historical decisions.
