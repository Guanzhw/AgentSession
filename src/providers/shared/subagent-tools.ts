const SUBAGENT_TOOL_NAMES = new Set([
  "agent",
  "task",
  "subtask",
  "spawn_agent",
  "delegate_task"
]);

export type SharedToolCategory = "agent" | "skill" | "lsp" | "mcp" | "tool";

export interface SharedToolClassification {
  category: SharedToolCategory;
  mcpServer: string | null;
}

function asMetadata(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Parts may retain provider metadata in `state.metadata` and add normalized
 * viewer fields at `metadata`. Merge them before testing semantic markers so
 * an unrelated normalized field cannot hide a source-side subagent marker.
 */
export function mergeToolMetadata(...values: unknown[]) {
  const rows = values.map(asMetadata);
  const merged = Object.assign({}, ...rows);
  if (rows.some((row) => row.subagent === true)) merged.subagent = true;
  if (rows.some((row) => row.isSubagent === true)) merged.isSubagent = true;
  return merged;
}

/**
 * Known historical launcher labels. Keep this compatibility list narrow: a
 * provider with arbitrary agent names must instead mark its normalized tool
 * metadata with `subagent: true`.
 */
export function isSubagentToolName(tool: unknown) {
  return SUBAGENT_TOOL_NAMES.has(String(tool || "").toLowerCase());
}

/**
 * Provider-neutral subagent classification. Parsers own the source-specific
 * decision and may set `metadata.subagent`; shared Tree, Trace, and
 * rendering code consume that normalized fact rather than guessing from a
 * provider's configurable tool name.
 */
export function isSubagentTool(tool: unknown, metadata?: unknown) {
  if (isSubagentToolName(tool)) return true;
  const row = asMetadata(metadata);
  return row?.subagent === true || row?.isSubagent === true;
}

/**
 * Shared classification for source-neutral tool names. Provider-specific
 * adapters may add their own source-defined conventions after this baseline.
 */
export function classifySharedTool(tool: unknown, metadata?: unknown): SharedToolClassification {
  const name = String(tool || "");
  const normalized = name.toLowerCase();
  if (isSubagentTool(name, metadata)) return { category: "agent", mcpServer: null };
  if (normalized === "skill") return { category: "skill", mcpServer: null };
  if (normalized.startsWith("lsp_")) return { category: "lsp", mcpServer: null };
  if (normalized.startsWith("mcp__")) {
    const [, server] = name.split("__");
    return { category: "mcp", mcpServer: server || null };
  }
  if (normalized.includes("__")) {
    const [server] = name.split("__");
    return { category: "mcp", mcpServer: server || null };
  }
  return { category: "tool", mcpServer: null };
}
