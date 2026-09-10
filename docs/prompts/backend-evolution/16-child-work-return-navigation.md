# Return from child execution to its originating work

Status: implemented and locally verified, 2026-09-11.

## Observed gap

On 2026-09-11, the real DSH workbench
`session-a9f5b448-9851-4872-a266-fdc3381a5061` opened its recorded child
`09df3e2d-0d89-4d69-b6ed-065c867fd418` successfully. The child's Back link
targeted `/sessions`, losing the originating workbench and selected run.

`runtime-workbench.ts` currently creates only the canonical child URL.
`parseSessionNavigationContext()` accepts library/statistics return paths,
not a parent detail destination. Run paging and selection are not restored
by this link. This does not satisfy the visual design's explicit child-return
requirement.

## Required outcome

- Open a recorded child from a run, including a run reached through paging.
  Keep the child's provider-owned canonical identity unchanged.
- Offer a clear return to the originating parent workbench and selected run,
  preserving the originating run page where the recorded anchor remains valid.
- Keep completed-work disclosure consistent with restored selection. Missing
  or changed evidence remains explicit; do not select a different run by index.
- Preserve direct child URLs and existing library/statistics breadcrumbs.
  Back/forward and opening a child in another tab should remain understandable.
- Use the smallest viewer-owned navigation mechanism supported by the existing
  routing contract. If widening accepted return targets, validate exact local
  detail routes at that boundary and document the decision. Never accept
  arbitrary external return destinations or mutate provider data.

## Verification

Test canonical IDs with encoded characters, invalid/external return targets,
existing library/statistics navigation, and absent/stale recorded anchors.
Use real DSH and a later-page Codex child for browser navigation, return,
selection and keyboard checks. Run the affected-surface validation matrix and
independent review. Do not claim that browser history alone implements a
visible return control unless that behavior is actually provided and tested.
