# AgentSession 3.0 stable readiness

Status: user-authorized goal, 2026-10-11. The user explicitly selected **3.0
stable**, rather than another prerelease. The acceptance contract and delivery
plan remain the owners of product behavior and release gates.

## Outcome

Produce an evidence-backed stable-release decision for the complete local
candidate. Repair observed blockers, validate affected real surfaces, and obtain
independent review. On 2026-10-12 the user first authorized publication after
completion, then explicitly instructed immediate publication because restarting
Codex was not possible. The [release disposition](../../../.agents/decisions/implemented/2026-10-12-user-authorized-stable-publication.md)
authorizes publishing the reviewed candidate with the remaining acceptance
limits documented. The measured statuses below retain their actual evidence;
publication does not convert an incomplete or failed check into a pass.

## Acceptance

| ID | Required result |
| --- | --- |
| STABLE-01 | Reconcile every open stable gate in the delivery plan with primary evidence. Historical failures retain their scope and identity; no gate is closed by an unrelated successful check. |
| SOURCE-01 | Establish the five-provider latest/rare-format evidence required by SRC-01/02, with recorded producer/capture facts, an independent source oracle, complete bounded retrieval and preserved source hashes. |
| FLOW-01 | Validate the complete Library → Reader → late search → child/related history → Runtime → return journey, truthful availability, English/Chinese, light/dark, keyboard focus and reduced motion on an identified desktop candidate. |
| RESOURCE-01 | Apply the existing frozen DEL-01/03 semantic and resource criteria to an exact optimized candidate and frozen inputs, including shared Web/MCP, refresh, restart and recovery. |
| STATE-01 | Resolve the historical state-preservation gate through attributable evidence and validate current source/user-state preservation separately. Missing historical facts remain explicit. |
| HUMAN-01 | Present a concrete reviewable desktop candidate and collect actual human task/reading/visual feedback for UX-01, then resolve actionable feedback. Agent screenshots do not substitute for that response. |
| RELEASE-01 | The release pipeline supports stable versions as npm `latest` and normal GitHub releases, while retaining prerelease `next` behavior and immutable tag/artifact/provenance validation. Manual validation does not publish. |
| PACKAGE-01 | Verify the identified candidate through full relevant checks and installed/packed artifacts, declared Node support, and actual affected platform evidence. An earlier rc.4 CI run is baseline evidence only. |
| REVIEW-01 | Complete fresh independent review of the final changes and evidence, fix findings, and revalidate affected behavior. The final decision identifies exact candidate, commands, reused evidence and remaining constraints. |

## Boundaries

Provider sources and existing user state remain read-only. Mutations use
task-owned copies and isolated Viewer state. Preserve the existing port-3457
service. Preserve all earlier unreleased work in this chat. Findings must come
from source, observed behavior or missing acceptance evidence; do not expand
features merely to increase scope.
