# OpenCode vs CodeAgent Database Schema Differences

## Overview

OpenSessionViewer supports two OpenCode-like providers that share core tables but differ in data denormalization:

| Provider | Database | Path |
|----------|----------|------|
| opencode | `opencode.db` | `$LOCALAPPDATA/opencode/opencode.db` |
| codeagent | `ngagent.db` | `$XDG_DATA_HOME/opencode/db/ngagent.db` |

## Shared Core Schema

Both databases share the same fundamental structure:

```
session
├── id (PK)
├── project_id (FK)
├── parent_id
├── slug
├── directory
├── title
├── time_created
├── time_updated
└── ...other columns

message
├── id (PK)
├── session_id (FK)
├── time_created
├── data (JSON text)
└── ...other columns

part
├── id (PK)
├── message_id (FK)
├── session_id (FK)
├── time_created
└── data (JSON text)
```

## Critical Schema Differences

### session table

| Column | opencode.db | ngagent.db | Notes |
|--------|-------------|------------|-------|
| `agent` | ✅ | ❌ | Stored in `message.data.agent` |
| `model` | ✅ | ❌ | Stored in `message.data.model` |
| `cost` | ✅ | ❌ | Stored in `message.data.cost` |
| `tokens_input` | ✅ | ❌ | Stored in `message.data.tokens.input` |
| `tokens_output` | ✅ | ❌ | Stored in `message.data.tokens.output` |
| `tokens_reasoning` | ✅ | ❌ | Stored in `message.data.tokens.reasoning` |
| `tokens_cache_read` | ✅ | ❌ | Stored in `message.data.tokens.cache.read` |
| `tokens_cache_write` | ✅ | ❌ | Stored in `message.data.tokens.cache.write` |
| `path` | ✅ | ❌ | N/A |
| `workspace_id` | ❌ | ✅ | Different tracking approach |
| `compaction_count` | ❌ | ✅ | Session compaction tracking |

### ngagent.db-only tables

```sql
-- Per-message detailed metrics
CREATE TABLE metrics (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  ttft_ms INTEGER,
  total_duration_ms INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  tokens_per_second REAL,
  has_error INTEGER NOT NULL DEFAULT 0,
  error_type TEXT,
  error_message TEXT,
  finish_reason TEXT,
  ...
);

-- Message feedback
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  feedback_type TEXT NOT NULL,
  modification_count INTEGER NOT NULL DEFAULT 0,
  ...
);
```

### opencode.db-only tables

```sql
CREATE TABLE event_sequence (
  aggregate_id text PRIMARY KEY,
  seq integer NOT NULL,
  owner_id text
);

CREATE TABLE event (
  id text PRIMARY KEY,
  aggregate_id text NOT NULL,
  seq integer NOT NULL,
  type text NOT NULL,
  data text NOT NULL,
  ...
);
```

## message.data JSON Structure

### opencode.db (assistant message)

```json
{
  "role": "assistant",
  "time": { "created": 1776937031395, "completed": 1776937033042 },
  "agent": "build",
  "model": { "providerID": "w3", "modelID": "MiniMax-M2.5" },
  "mode": "build",
  "path": { "cwd": "D:\\CodeSpace", "root": "/" },
  "cost": 0,
  "tokens": {
    "input": 0,
    "output": 0,
    "reasoning": 0,
    "cache": { "read": 0, "write": 0 }
  }
}
```

### ngagent.db (assistant message)

```json
{
  "role": "assistant",
  "time": { "created": 1778747944445, "completed": 1778747944757 },
  "parentID": "msg_e25a3ac830013lk1LXKCU7qTMa",
  "modelID": "MiniMax-M2.5",
  "providerID": "w3",
  "mode": "build",
  "agent": "build",
  "path": { "cwd": "D:\\CodeSpace", "root": "/" },
  "cost": 0,
  "tokens": {
    "input": 0,
    "output": 0,
    "reasoning": 0,
    "cache": { "read": 0, "write": 0 }
  }
}
```

## Impact on OpenSessionViewer

### Current Problem

The function `isOpenCodeLikeProvider()` in `src/providers/kinds.ts:3-4` returns `true` for both providers:

```typescript
export function isOpenCodeLikeProvider(providerId: string | ProviderId | null | undefined) {
  return providerId === "opencode" || providerId === "codeagent";
}
```

This causes `server.ts` to call OpenCode-specific functions for CodeAgent sessions:

```typescript
// server.ts:613-616
const sessionTree = isOpenCodeLikeProvider(providerId) ? buildOpenCodeSessionTree(id, adapter.getDataPath()) : null;
const sessionContainer = isOpenCodeLikeProvider(providerId) ? buildOpenCodeSessionContainer(id, adapter.getDataPath()) : null;
const sessionMetrics = isOpenCodeLikeProvider(providerId) ? buildOpenCodeSessionMetrics(id, adapter.getDataPath()) : null;
const sessionFlow = isOpenCodeLikeProvider(providerId) ? buildOpenCodeFlowTree(id, adapter.getDataPath()) : null;
```

### Broken Code Path

`calculateMetrics()` in `src/providers/opencode/session-tree.ts:123-128` reads from session columns:

```typescript
inputTokens: asNumber(session.tokens_input) + childMetrics.reduce(...),
outputTokens: asNumber(session.tokens_output) + childMetrics.reduce(...),
reasoningTokens: asNumber(session.tokens_reasoning) + childMetrics.reduce(...),
cacheReadTokens: asNumber(session.tokens_cache_read) + childMetrics.reduce(...),
cacheWriteTokens: asNumber(session.tokens_cache_write) + childMetrics.reduce(...),
cost: asNumber(session.cost) + childMetrics.reduce(...),
```

For CodeAgent (ngagent.db), these columns don't exist, resulting in:
- **token counts**: 0
- **cost**: 0
- **agent/model**: undefined in UI displays

## Data Extraction Differences

| Data | opencode.db Query | ngagent.db Query |
|------|-------------------|------------------|
| Agent | `SELECT agent FROM session` | `SELECT json_extract(data, '$.agent') FROM message WHERE role='assistant'` |
| Model | `SELECT model FROM session` | `SELECT json_extract(data, '$.modelID') FROM message WHERE role='assistant'` |
| Input Tokens | `SELECT tokens_input FROM session` | `SELECT json_extract(data, '$.tokens.input') FROM message WHERE role='assistant'` |
| Cost | `SELECT cost FROM session` | `SELECT json_extract(data, '$.cost') FROM message WHERE role='assistant'` |
