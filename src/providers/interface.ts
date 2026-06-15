export type ProviderId = "opencode" | "codeagent" | "claude-code" | "codex" | "gemini";

export interface ResumeCommandSpec {
  executable: string;
  args: string[];
  cwd?: string;
}

export interface ResumeShellSpec {
  executable: string;
  args?: string[];
}

export interface AnalysisCommandSpec extends ResumeCommandSpec {
  stdin?: "prompt";
}

export interface TokenUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  total?: number;
  cache?: {
    read?: number;
    write?: number;
  };
}

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
  tokens: TokenUsage | null;
  metadata: Record<string, unknown> | null;
}

export interface DailyTokenStat {
  day: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  messageCount: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface SearchResult {
  sessionId: string;
  messageId: string;
  role: MessageRole | string;
  snippet: string;
  timestamp: number;
}

export type RuntimeExtensionScope = "project" | "user";

export type RuntimeExtensionKind =
  | "instruction"
  | "skill"
  | "agent"
  | "command"
  | "plugin"
  | "hook"
  | "tool"
  | "rule"
  | "extension";

export interface RuntimeExtensionReference {
  id: string;
  provider: ProviderId;
  scope: RuntimeExtensionScope;
  kind: RuntimeExtensionKind;
  name: string;
  source: string;
  sourcePath: string | null;
  sourceType: "directory" | "file" | "package" | "config";
  available: boolean;
  capturable: boolean;
  defaultSelected: boolean;
  note: string;
}

export interface RuntimeEnvironmentView {
  sessionId: string;
  resolution: "current-local";
  note: string;
  extensions: RuntimeExtensionReference[];
}

export interface ProviderAdapter {
  id: ProviderId;
  name: string;
  icon: string;
  resumeCommand?: ResumeCommandSpec;
  capabilities?: {
    localManagement?: boolean;
    sqliteSessionStore?: boolean;
    structuredSessionViews?: boolean;
  };
  detect(): boolean;
  getDataPath(): string | null;
  scan(): AsyncIterable<RawSession>;
  getSession(sessionId: string): RawSession | Record<string, unknown> | null;
  getMessages(sessionId: string): Message[];
  getTokenStats(days?: number): DailyTokenStat[];
  searchMessages(query: string, limit?: number): SearchResult[];
  exportSession(sessionId: string): unknown;
  getRuntimeEnvironment?(sessionId: string): RuntimeEnvironmentView | null;
  getSystemPrompts?(sessionId: string): unknown;
  getTrace?(sessionId: string): unknown;
  getSessionTree?(sessionId: string): unknown;
  getSessionContainer?(sessionId: string): unknown;
  getSessionMetrics?(sessionId: string): unknown;
  getSessionFlow?(sessionId: string): unknown;
  getUnavailableReason?(): string | null;
}
