---
status: implemented
date: 2026-09-30
decision: Preserve provider-recorded model provider alongside each selected request usage record
---

# Recorded model providers in request usage

## Context

Exact model pricing consumes a model-provider and model pair. The Codex,
DeepSeek Harness, and Pi adapters discarded explicit model-provider evidence
by setting `UsageRecord.model_provider` to `None`. Frozen source and read-only
Protocol checks confirmed the loss. The frozen Claude transcript has recorded
models and usage but no explicit model-provider field.

The bounded source audit checked all 840 Codex first-record headers and fully
decoded two selected Codex sources, one Claude source, one Pi source, and
three DSH sources. Every Codex header records `payload.model_provider`;
the long Codex sample additionally records `model_provider_id` on all 25
`thread_settings_applied` selections. Pi's one frozen assistant request
records `message.provider`. Each of the unseeded DSH v0/v3 sources records
508 assistant settlements with model and provider together; the seeded v0
source has one owned settlement. These counts describe the bounded sources,
not a census of request ownership across the complete source set.

## Decision

The [Codex adapter](../../../v3/crates/core/src/providers/codex.rs) preserves
`session_meta.payload.model_provider` only for the canonical usage owner.
Changing the recorded owner clears preceding model selection state. A later
`thread_settings_applied` model selection replaces both the model and its
explicit `model_provider_id` when its recorded `thread_id` belongs to the
current usage owner. The historical absent/null owner remains accepted;
explicit foreign-owner settings cannot replace the selection. The
[official Codex owner field](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/protocol/src/protocol.rs#L2200-L2207)
retains the original logical owner on copied resume snapshots. An absent
provider remains unknown for an accepted selection.

The [DSH adapter](../../../v3/crates/core/src/providers/deepseek_harness.rs)
selects the same source object used for the recorded model, in existing
message-source, source, and provenance order, then reads its provider. It
keeps the existing seed boundary, retry, attempt-to-settlement replacement,
and token selection. The [Pi adapter](../../../v3/crates/core/src/providers/pi.rs)
reads the selected assistant message's `provider`, keeping response identity
and active-branch occurrence selection. Claude retains unknown provider.

Provider normalization revision salts advance for Codex normal and
[direct source sets](../../../v3/crates/core/src/providers/codex_source_set.rs),
Pi, and DSH generations so an unchanged transcript cannot retain an old
projection identity. The shared [statistics projection](../../../v3/crates/core/src/stats.rs)
version advances to invalidate persisted request rows created before these
fields were retained.

## Alternatives considered

Inferring a vendor from a model name, coding-agent identity, global endpoint,
or a different DSH source object would manufacture pricing identity. Carrying
a parent model selection across a recorded owner change would attach usage
to the wrong model. Keeping old normalization revisions would let unchanged
source bytes identify incompatible projections.

## Consequences

Recorded provider identifiers remain exact source labels, including `openai`,
`deepseek`, and `deepseek-official`; adapters do not alias them to vendors.
Requests with an unknown provider remain available as recorded usage and
require the pricing consumer's explicit unknown-provider behavior. Pricing
does not alter source transcripts, usage amounts, request identity, or event
membership.

## Verification

The focused HTTP tests first failed on the existing executable: Pi omitted
its recorded provider; DSH omitted the settlement provider; Codex omitted
the provider and carried a parent model across an owner change. Tests cover
same-model provider changes, missing provider state, copied-owner reset,
DSH same-source priority and settlement replacement, Pi active response
selection, and unknown providers despite model names. Frozen source hashes
are verified around scratch HTTP calls.

`node --test v3/test/codex-request-usage-protocol.test.mjs
v3/test/dsh-protocol-foundation-http.test.mjs
v3/test/pi-request-usage-protocol.test.mjs` passed 29 tests; the one
manifest-gated Codex case was then run with
`AGENTSESSION_V3_REAL_MANIFEST=tmp/v3-corpus/manifest.private.json` and passed.
The frozen DSH v3 test independently compares every selected settlement's
model provider as well as its usage components.

The ignored `tmp/v3-delivery/recorded-model-provider-evidence/cache-check.mjs`
prepared a scratch derived cache using the preceding executable, then compared
the new executable's old-cache and fresh-cache Protocol and Stats documents.
The documents matched exactly: 1,138 single-source Codex requests retained
`openai`, one Pi request retained `deepseek`, and 508 selected native-v3 DSH
requests retained `deepseek-official`; the Claude request retained unknown
provider. Request counts and token vectors matched the preceding executable,
all frozen input/copy hashes remained unchanged, and mapped provider revisions
changed. A read-only SQLite check confirmed the old Codex statistics projection
6 row was replaced by projection 7. Single-source Codex request membership
differs from the full frozen source-set projection; this comparison holds
source scope fixed across the two executables.

An independent owner-filter regression was RED before the foreign-owner
filter. The final integrated debug executable `c8e78e78` passes all 13 Codex
request-usage checks, including the frozen source oracle. The first follow-up
used an incorrect Stats URL and the next used the wrong manifest schema;
both harness failures remain separate from the final run.

Independent old-cache checks on `fddb414e` found that the Codex optimized
statistics source revision still reused foreign-model rows while Protocol
already reflected the owner filter. Advancing that owning source namespace
from 9 to 10 makes the original `73c4ba12` warmed state equal a fresh cache
on `c8e78e78`: both requests retain the owned model/vendor, input sums to 17,
and native omitted cache-write is zero. The acceptance script asserts those
facts and exits successfully. Failed and final evidence remain under
`tmp/v3-delivery/independent-token-review/`; source hashes are unchanged and
all reviewer-owned processes closed. Codex normal/direct namespaces are now
5/4, and shared Stats is version 8. These are debug integration results;
release packaging remains part of the delivery gates.
