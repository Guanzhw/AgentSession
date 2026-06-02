# Contributing a New Provider

This guide explains how to add support for a new AI coding tool to OpenSessionViewer. Each provider is a lightweight adapter that implements a standard interface to expose session data.

## Provider Adapter Interface

Every provider must export a default object matching this shape (see `src/providers/interface.ts` for full TypeScript definitions):

```javascript
{
  id: "provider-id",           // Unique identifier (lowercase, used in URLs)
  name: "Display Name",        // Human-readable name for UI
  icon: "🔵",                  // Emoji or icon reference
  
  detect() → boolean,          // Is this tool installed on this machine?
  getDataPath() → string|null, // Root path to session data
  scan() → AsyncIterable,      // Stream all session metadata
  getSession(id) → object|null,// Get single session detail
  getMessages(id) → Message[], // Get all messages for a session
  getTokenStats(days) → DailyTokenStat[], // Token usage by day
  searchMessages(query, limit) → SearchResult[], // Full-text search
  exportSession(id) → object|null // Reserved for future (return null in v1)
}
```

### Method Signatures

**detect()** → `boolean`
- Returns true if the tool's data directory exists on this machine
- Example: Check if `~/.config/gemini/tmp` exists

**getDataPath()** → `string | null`
- Returns the root directory containing session data
- Used for logging and debugging
- Can return null if data is not file-based

**scan()** → `AsyncIterable<RawSession>`
- Generator function that yields session metadata
- Called during startup to index all sessions
- Each yielded object must have: `id`, `provider`, `title`, `timeCreated`, `timeUpdated`, `messageCount`

**getSession(sessionId)** → `object | null`
- Returns full session metadata for a specific ID
- Must include all fields from RawSession type
- Return null if session not found

**getMessages(sessionId)** → `Message[]`
- Returns all messages in a session
- Each message must have: `id`, `sessionId`, `role`, `content`, `timestamp`
- Optional: `thinking`, `toolName`, `toolInput`, `toolOutput`, `tokens`, `metadata`

**getTokenStats(days)** → `DailyTokenStat[]`
- Returns token usage aggregated by day for the last N days
- Each entry: `{ day: "YYYY-MM-DD", inputTokens, outputTokens, totalTokens, messageCount }`
- Return empty array if tokens not tracked

**searchMessages(query, limit)** → `SearchResult[]`
- Full-text search across all messages
- Each result: `{ sessionId, messageId, role, snippet, timestamp }`
- Snippet should show context around the match (±40 chars)
- Return up to `limit` results

**exportSession(sessionId)** → `object | null`
- Reserved for future use — return null in v1

---

## Step-by-Step: Adding a New Provider

### Step 1: Create Provider Directory

Create `src/providers/{id}/` with two files:

```
src/providers/my-tool/
├── adapter.ts    # Main adapter implementation
└── parser.ts     # Helper to parse raw data into standard format
```

### Step 2: Implement the Adapter

In `src/providers/my-tool/adapter.ts`:

```javascript
import { parseSession, extractMeta, dataToMessages } from "./parser.js";

const myTool = {
  id: "my-tool",
  name: "My Tool CLI",
  icon: "🟢",

  detect() {
    // Check if tool is installed
    return existsSync(path.join(getMyToolDir(), "sessions"));
  },

  getDataPath() {
    return getMyToolDir();
  },

  async *scan() {
    // Yield all sessions
    for (const file of discoverSessionFiles()) {
      try {
        const data = parseSession(file);
        yield extractMeta(data);
      } catch { /* skip */ }
    }
  },

  getSession(sessionId) {
    // Find and return single session
    for (const file of discoverSessionFiles()) {
      try {
        const data = parseSession(file);
        if (data.sessionId === sessionId) return extractMeta(data);
      } catch { /* skip */ }
    }
    return null;
  },

  getMessages(sessionId) {
    // Return messages for session
    for (const file of discoverSessionFiles()) {
      try {
        const data = parseSession(file);
        if (data.sessionId === sessionId) return dataToMessages(data, sessionId);
      } catch { /* skip */ }
    }
    return [];
  },

  getTokenStats(days = 30) {
    // Aggregate token usage by day
    const cutoff = Date.now() - days * 86400000;
    const dailyMap = new Map();
    // ... implementation ...
    return [...dailyMap.values()].sort((a, b) => a.day.localeCompare(b.day));
  },

  searchMessages(query, limit = 20) {
    // Full-text search
    const term = (query || "").toLowerCase();
    if (!term) return [];
    const results = [];
    // ... implementation ...
    return results;
  },

  exportSession() { return null; }
};

export default myTool;
```

### Step 3: Implement the Parser

In `src/providers/my-tool/parser.ts`, implement helpers:

```javascript
export function parseSession(filePath) {
  // Read and parse raw session file
  // Return object with: sessionId, messages, metadata
}

export function extractMeta(data) {
  // Convert parsed data to RawSession format
  return {
    id: data.sessionId,
    provider: "my-tool",
    title: data.title || null,
    directory: data.directory || null,
    timeCreated: data.createdAt || 0,
    timeUpdated: data.updatedAt || 0,
    messageCount: data.messages?.length || 0,
    tokenCount: data.totalTokens || null
  };
}

export function dataToMessages(data, sessionId) {
  // Convert parsed data to Message[] format
  return (data.messages || []).map(m => ({
    id: m.id,
    sessionId,
    role: m.role,
    content: m.text || "",
    timestamp: m.timestamp || 0,
    tokens: m.tokens ? { input: m.tokens.input, output: m.tokens.output } : null
  }));
}
```

### Step 4: Register the Provider

In `src/providers/index.ts`, add:

```javascript
import myTool from "./my-tool/adapter.js";

// ... existing registrations ...
registerProvider(myTool);
```

---

## Example: Gemini Adapter (Simplest Reference)

The Gemini adapter is the simplest implementation. Key patterns:

**File discovery** (`gemini/adapter.ts` lines 10-30):
```javascript
function discoverSessionFiles() {
  const tmpDir = path.join(getGeminiDir(), "tmp");
  if (!existsSync(tmpDir)) return [];
  const files = [];
  try {
    for (const projectDir of readdirSync(tmpDir)) {
      const chatsDir = path.join(tmpDir, projectDir, "chats");
      if (!existsSync(chatsDir)) continue;
      for (const entry of readdirSync(chatsDir)) {
        if (entry.endsWith(".json")) {
          files.push({ filePath: path.join(chatsDir, entry) });
        }
      }
    }
  } catch { /* skip */ }
  return files;
}
```

**Token stats aggregation** (`gemini/adapter.ts` lines 76-97):
```javascript
getTokenStats(days = 30) {
  const cutoff = Date.now() - days * 86400000;
  const dailyMap = new Map();
  for (const { filePath } of discoverSessionFiles()) {
    try {
      const data = parseSession(filePath);
      for (const m of data.messages || []) {
        if (m.type !== "gemini" || !m.tokenUsage) continue;
        const ts = m.timestamp ? new Date(m.timestamp).getTime() : 0;
        if (ts < cutoff) continue;
        const day = new Date(ts).toISOString().slice(0, 10);
        const existing = dailyMap.get(day) || { day, inputTokens: 0, outputTokens: 0, totalTokens: 0, messageCount: 0 };
        existing.inputTokens += m.tokenUsage.input || 0;
        existing.outputTokens += m.tokenUsage.output || 0;
        existing.totalTokens += m.tokenUsage.total || 0;
        existing.messageCount += 1;
        dailyMap.set(day, existing);
      }
    } catch { /* skip */ }
  }
  return [...dailyMap.values()].sort((a, b) => a.day.localeCompare(b.day));
}
```

**Search implementation** (`gemini/adapter.ts` lines 99-124):
```javascript
searchMessages(query, limit = 20) {
  const term = (query || "").toLowerCase();
  if (!term) return [];
  const results = [];
  for (const { filePath } of discoverSessionFiles()) {
    if (results.length >= limit) break;
    try {
      const data = parseSession(filePath);
      for (const m of data.messages || []) {
        if (results.length >= limit) break;
        const text = m.text || "";
        if (text.toLowerCase().includes(term)) {
          const idx = text.toLowerCase().indexOf(term);
          results.push({
            sessionId: data.sessionId,
            messageId: m.id || "",
            role: m.type === "user" ? "user" : "assistant",
            snippet: text.slice(Math.max(0, idx - 40), idx + term.length + 80),
            timestamp: m.timestamp ? new Date(m.timestamp).getTime() : 0
          });
        }
      }
    } catch { /* skip */ }
  }
  return results;
}
```

---

## QA Checklist

Before submitting your provider, verify all methods work:

- [ ] **detect()** — Returns true when tool is installed, false otherwise
- [ ] **scan()** — Yields at least one session (if data exists)
- [ ] **getSession(id)** — Returns correct session metadata
- [ ] **getMessages(id)** — Returns array of messages with role, content, timestamp
- [ ] **searchMessages(query)** — Returns results with snippet context
- [ ] **getTokenStats(days)** — Returns daily aggregates (or empty array if not tracked)
- [ ] **exportSession()** — Returns null (reserved for v2)

Test with:
```bash
npm run build
node -e "
import adapter from './dist/src/providers/my-tool/adapter.js';
console.log('Detected:', adapter.detect());
if (adapter.detect()) {
  for await (const s of adapter.scan()) {
    console.log('Session:', s.id, s.title);
    break;
  }
}
"
```

---

## File Structure Convention

```
src/providers/
├── interface.ts          # Type definitions (TypeScript)
├── index.ts              # Registration hub
├── opencode/
│   ├── adapter.ts        # Main adapter
│   └── parser.ts         # Parsing helpers
├── claude-code/
│   ├── adapter.ts
│   └── parser.ts
├── codex/
│   ├── adapter.ts
│   └── parser.ts
└── gemini/
    ├── adapter.ts
    └── parser.ts
```

Each provider is self-contained. The adapter imports its parser, and `index.ts` imports all adapters for registration.

---

## Tips

1. **Error handling**: Wrap file I/O in try-catch. Silently skip corrupted files.
2. **Performance**: Cache file discovery if possible. Avoid re-scanning on every method call.
3. **Timestamps**: Always use Unix milliseconds (Date.now() format).
4. **Snippets**: Include ±40 characters of context around search matches.
5. **Null safety**: Return empty arrays/null rather than throwing errors.
6. **Async generators**: Use `async *scan()` for streaming large datasets.

---

## Questions?

Refer to:
- `src/providers/interface.ts` — Full type definitions
- `src/providers/gemini/` — Simplest working example
- `src/server.ts` — How adapters are used in routing
