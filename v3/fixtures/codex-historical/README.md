# Historical Codex collaboration fixture

Sanitized `multi_agent_v1` call/output shapes from selected historical records.
The fixture has two verified UUID acknowledgments, four explicit plaintext
failures, one successful unresolved acknowledgment, one opaque unknown output,
multi-target waits, a resume snapshot, accepted input, a later completion and
a close prior-completion snapshot. A third explicit selected child header has
no parent dispatch. All IDs, text and paths are synthetic.

The first assignment completes at native event 10 and keeps that terminal when
follow-up input completes later. Close supplies prior completion for the second
assignment with unknown execution end time. The independent third child remains
Unknown with no task, turn, timestamps, terminal or Reader placement.
