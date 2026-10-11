# Reader journey repair requirements

Status: approved for implementation by the user on 2026-10-11.

## Problem and evidence

A desktop audit of the installed 3.0.0-rc.4 Windows artifact reproduced four
broken user journeys and one source-setup guidance gap. The audit used public
Codex/DeepSeek Harness fixtures, isolated Viewer state and a task-owned long
message copy. Evidence is retained under ignored
`tmp/product-audit-20261011/` (report, ten screenshots and fixture manifest).

## Acceptance requirements

| ID | User outcome | Acceptance |
| --- | --- | --- |
| SEARCH-01 | Open the text found by global content search | A hit beyond the initial body window is revealed and highlighted in Reader on the first click. Use the same normalized content and position units as Reader search; handle Unicode correctly. Content remains bounded. Title/directory hits retain their existing navigation. |
| SEARCH-02 | Return to the search results | Browser Back restores the submitted query, result list and selected result context. Normal links, including modified-click/new-tab destinations, retain the target. |
| STAR-01 | Find a saved conversation later | Library rows show their own Viewer star state. An only-starred filter uses core Library filtering and works with existing provider/project/time/sort and family navigation. Star/unstar, browser Back and restart keep a consistent result. |
| RUNTIME-01 | Inspect evidence and return to the investigation | Technical-details lens, applied Events filters, current Events page and scroll context survive source-link navigation to Reader and browser Back. The same path works when first entering Technical details directly from Conversation. Forward returns to the source event. |
| RUNTIME-02 | Preserve existing related-session navigation | Sessions lens selection remains recoverable after opening a related session. Restored evidence continues to obey source revision/cursor errors. |
| TRASH-01 | Know whether recoverable records were actually read | All-failed reads do not claim an empty Trash or a confirmed zero count. Partial success preserves readable rows and marks the listing incomplete. Only a successful zero-row read shows an empty state. An explicit retry can recover. |
| SETUP-01 | Repair an unavailable source from its diagnostic | A source issue links to its specific source configuration in Settings. That destination shows the current path, the applicable configuration field/CLI option and concrete restart/recheck instructions. Explain precedence accurately; preserve startup-selected path semantics. |
| UI-01 | Use the changed controls in either language | New controls and status text have English/Chinese labels, semantic accessible names and visible keyboard focus. Preserve the existing desktop layout and responsive behavior. |

## Invariants and delivery boundary

Provider sources stay read-only. Viewer metadata remains scope-isolated. Public
identity stays provider plus canonical session ID. Provider path/decoding facts
stay provider-owned; shared UI consumes normalized facts and documented public
configuration contracts. Preserve existing explicit unavailable/stale/error
states and bounded retrieval.

The user authorized implementation and validation. Existing unreleased npm
routing, private-test reporting and documentation work remains intact. This
change is delivered locally; release publication and unrelated stable-release
gates are separate work.

## Required evidence

Use focused Rust/integration regressions for changed contracts and real desktop
browser checks for the five journeys. Run the UI build, repository review gate,
affected tests, task-owned native restart and direct API checks. An independent
fresh-context review must inspect the integrated diff. Record actual failures,
repairs, checks and remaining evidence gaps in [tasks.md](tasks.md).
