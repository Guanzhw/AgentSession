# Three-level Codex child history

This public corpus contains three synthetic Codex JSONL sessions with canonical
UUIDs and two parent-child edges. The records exercise a recorded
`spawn_agent` function call, its matching `function_call_output` JSON
`task_name`, an adjacent `item_completed` / `SubAgentActivity` cross-check,
and child `session_meta` parent and `agent_path` values.

| Role | Session ID | Parent | Spawn tool part |
|:---|:---|:---|:---|
| Root | `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa` | — | `SPAWN_ITEM:tool` |
| Child | `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb` | Root | `GRANDCHILD_SPAWN_ITEM:tool` |
| Grandchild | `cccccccc-cccc-4ccc-8ccc-cccccccccccc` | Child | — |

The fixed AgentSession 2.0 adapter resolves both edges as `explicit`, with
`detached: false`, and places them after the matching spawn tool parts. The
3.0 acceptance test expects each placement's source evidence at the matching
`function_call_output` (`event:codex:5`) and its display anchor at the
`function_call` tool part. The grandchild has 33 owned messages and a long
final message to exercise Reader and content continuation.

This corpus is fully synthetic and models the public record shape; it contains
no private transcript text or session IDs.

SHA-256:

| File | SHA-256 |
|:---|:---|
| `sessions/2026/09/27/rollout-2026-09-27T00-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl` | `57165a2f67a487f73d6db092bacec514db1b729b90c5558e72f5608e03c87774` |
| `sessions/2026/09/27/rollout-2026-09-27T00-01-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl` | `982b77d2ad0e029b295c35b973be61b4b09a18a3e19e554e9c30a352abccbaa2` |
| `sessions/2026/09/27/rollout-2026-09-27T00-02-00-cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl` | `e69dc00865b156177c9507df224fda7c1a424a4447a17e2c729d1c7efcf2e689` |
