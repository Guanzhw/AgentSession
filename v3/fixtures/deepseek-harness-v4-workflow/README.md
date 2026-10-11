# DSH v4 workflow run-record reproduction

This is a bounded public reproduction of required workflow run records observed
in an authentic `@deepseek-ai/dsh@0.2.0-rc.2` headless capture on 2026-10-11.
The two run payloads, timestamps and run id preserve the producer-written
shape. The header identity, sequence positions and surrounding messages are
controlled public fixture data; this fixture is not the authentic capture.

The original task-owned compressed capture has 48 physical records. Its run
starts at source sequence 18 and ends at 19 with `stopReason: error`, after
Windows sandbox provisioning fails. The frozen pre-fix candidate returns
HTTP 500 for that real session because the required run-start type is absent
from modern DSH admission. Private producer/version/capture pairing, hashes,
raw oracle and red native evidence are retained under the ignored stable task
directory and are separately required for real-source validation.

These run records are log-only source observations. They create no Reader
message, child relationship, task or inferred AgentRun identity. The official
tool-workflow producer emits nonempty `runId` and `name` on run-start and one
of `completed`, `cancelled` or `error` on run-end. Member lifecycle is recorded
separately by `tool-workflow/agent-start` and `tool-workflow/agent-end`.
