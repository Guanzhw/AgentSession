export type ProviderId = "opencode" | "codeagent" | "claude-code" | "codex" | "gemini";

export interface RawSession {
  id: string;
  provider: ProviderId;
  parentId: string | null;
  title: string | null;
  directory: string | null;
  timeCreated: number;
  timeUpdated: number;
  messageCount: number;
  tokenCount: number | null;
}

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole | string;
  content: string;
  thinking: string | null;
  toolName: string | null;
  toolInput: unknown;
  toolOutput: unknown;
  timestamp: number;
  tokens: { input: number; output: number } | null;
  metadata: Record<string, unknown> | null;
}

export interface DailyTokenStat {
  day: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  messageCount: number;
}

export interface SearchResult {
  sessionId: string;
  messageId: string;
  role: MessageRole | string;
  snippet: string;
  timestamp: number;
}

export interface ProviderAdapter {
  id: ProviderId;
  name: string;
  icon: string;
  detect(): boolean;
  getDataPath(): string | null;
  scan(): AsyncIterable<RawSession>;
  getSession(sessionId: string): RawSession | Record<string, unknown> | null;
  getMessages(sessionId: string): Message[];
  getTokenStats(days?: number): DailyTokenStat[];
  searchMessages(query: string, limit?: number): SearchResult[];
  exportSession(sessionId: string): unknown;
  getTrace?(sessionId: string): unknown;
}
