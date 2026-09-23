import type { Message, TokenUsage } from "../interface.js";

export interface V2MessageRow {
  id: string; session_id: string; type: string; seq: number;
  time_created: number; time_updated: number; data: string;
}
export interface V2Record extends Omit<V2MessageRow, "data"> { data: Record<string, any> }

export function decodeV2Record(row: V2MessageRow): V2Record {
  let data: unknown;
  try { data = JSON.parse(row.data); } catch { throw new Error(`Invalid OpenCode v2 message JSON: ${row.id}`); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`Invalid OpenCode v2 message: ${row.id}`);
  return { ...row, data: data as Record<string, any> };
}

export function v2Tokens(value: any): TokenUsage | null {
  if (value == null) return null;
  const n = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  return { input: n(value.input), output: n(value.output), reasoning: n(value.reasoning), cache: { read: n(value.cache?.read), write: n(value.cache?.write) } };
}
export function v2Total(tokens: TokenUsage | null): number {
  return tokens ? (tokens.input || 0) + (tokens.output || 0) + (tokens.reasoning || 0) + (tokens.cache?.read || 0) + (tokens.cache?.write || 0) : 0;
}
const text = (value: unknown) => typeof value === "string" ? value : "";
function contentText(content: any): string {
  return Array.isArray(content) ? content.map(part => part.type === "text" ? text(part.text) : part.type === "file" ? `[${text(part.name) || text(part.mime)}] ${text(part.uri)}` : JSON.stringify(part)).join("\n") : "";
}

/** Schema evidence: OpenCode v2.0.10 packages/schema/src/session-message.ts. */
export function normalizeV2Messages(records: V2Record[]): Message[] {
  return records.flatMap(row => {
    const data = row.data;
    const base: Message = {
      id: row.id, sessionId: row.session_id, role: "system", content: "", thinking: null,
      toolName: null, toolInput: null, toolOutput: null, timestamp: row.time_created,
      tokens: null, metadata: { sourceType: row.type, sourceMessageId: row.id, sourceSequence: row.seq }
    };
    if (row.type === "assistant") {
      if (!Array.isArray(data.content)) throw new Error(`Invalid OpenCode v2 assistant content: ${row.id}`);
      const metadata = { ...base.metadata, responseGroupId: row.id, model: data.model?.id, provider: data.model?.providerID, agent: data.agent, cost: data.cost, finish: data.finish, error: data.error };
      // Retain a canonical envelope even for a tool-only or in-flight response.
      const envelope: Message = { ...base, role: "assistant", tokens: v2Tokens(data.tokens), metadata };
      const parts: Message[] = data.content.map((part: any, index: number) => {
        const item: Message = { ...base, id: `${row.id}:content:${index}`, role: "assistant", metadata: { ...metadata, cost: undefined } };
        if (part.type === "text") return { ...item, content: text(part.text) };
        if (part.type === "reasoning") return { ...item, thinking: text(part.text) };
        if (part.type === "tool") {
          if (!part.state || typeof part.name !== "string") throw new Error(`Invalid OpenCode v2 tool: ${row.id}:${index}`);
          const output = part.state.status === "error" ? JSON.stringify(part.state.error) : contentText(part.state.content);
          return { ...item, role: "tool", toolName: part.name, toolInput: part.state.input ?? null,
            toolOutput: output ?? null, content: output || "", timestamp: part.time?.created ?? row.time_created,
            metadata: { ...item.metadata, providerMetadata: part.state.metadata, responseGroupId: row.id, sourceMessageId: row.id, sourceSequence: row.seq,
              callId: part.id, status: part.state.status, isError: part.state.status === "error",
              timeStart: part.time?.ran ?? part.time?.created, timeEnd: part.time?.completed,
              content: part.state.content, error: part.state.error } };
        }
        throw new Error(`Unsupported OpenCode v2 assistant content type: ${part.type}`);
      });
      return [envelope, ...parts];
    }
    if (row.type === "user") return [{ ...base, role: "user", content: text(data.text), metadata: { ...base.metadata, files: data.files, agents: data.agents, skills: data.skills } }];
    if (["system", "synthetic", "skill"].includes(row.type)) return [{ ...base, content: text(data.text), metadata: { ...base.metadata, description: data.description } }];
    if (row.type === "compaction") return [{ ...base, content: text(data.summary) || `Compaction: ${text(data.status)}`, tokens: v2Tokens(data.tokens),
      metadata: { ...base.metadata, status: data.status, reason: data.reason, recent: data.recent, cost: data.cost, error: data.error, model: data.model?.id, provider: data.model?.providerID } }];
    // Shell is a user-initiated shell record, not an assistant tool call.
    if (row.type === "shell") return [{ ...base, content: `$ ${text(data.command)}\n${typeof data.output === "string" ? data.output : JSON.stringify(data.output ?? "")}`, metadata: { ...base.metadata, status: data.status, exit: data.exit } }];
    // Keep control/unknown records visible and exportable, without fabricating agent work.
    return [{ ...base, content: `${row.type}: ${JSON.stringify(data)}` }];
  });
}
