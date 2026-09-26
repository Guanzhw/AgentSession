import type { AgentRun, ContextArtifactEvidenceRequest, ContextArtifactEvidenceResult, ContextArtifactSourceState, EventProvenance, ProtocolCapabilities, SessionProtocol, SessionRelationship, Task } from "./shared/session-protocol.js";
import type { CoordinationObservation, SessionProtocolV3 } from "./shared/session-protocol-v3.js";
import type { SessionTree } from "./shared/session-tree.js";

export type ProviderId = "opencode" | "claude-code" | "codex" | "pi" | "deepseek-harness";

export interface ResumeCommandSpec {
  executable: string;
  args: string[];
  cwd?: string;
}

export interface ResumeShellSpec {
  executable: string;
  args?: string[];
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
  /** Bounded provider-owned user text retained in the viewer index for Library identification. */
  libraryEvidence?: string[];
  metadata?: Record<string, unknown> | null;
}

export type LibrarySessionMetadata = Pick<RawSession,
  "id" | "provider" | "parentId" | "title" | "directory" | "timeCreated" | "timeUpdated">;

export type MessageRole = "user" | "assistant" | "system" | "tool";

/**
 * Provider-recorded response presentation boundary. Missing values stay
 * undefined because an adapter must not infer a final response.
 */
export type MessagePresentationPhase = "commentary" | "final";

/** Recorded user question-answer content, presented beside unchanged raw text. */
export interface QuestionAnswer {
  id: string;
  question: string;
  answer: string;
}

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  thinking: string | null;
  toolName: string | null;
  toolInput: unknown;
  toolOutput: unknown;
  timestamp: number;
  tokens: TokenUsage | null;
  metadata: Record<string, unknown> | null;
  presentationPhase?: MessagePresentationPhase;
  questionAnswers?: QuestionAnswer[];
}

/**
 * Bounded, read-only context copied into a session by its provider. This is a
 * disclosure projection only: it is intentionally separate from owned
 * messages, token accounting, search indexes, exports, and runtime protocol
 * projections.
 */
export interface InheritedContextView {
  /** The prefix can be recorded even when its source session identity is absent. */
  sourceSession: {
    provider: ProviderId;
    sessionId: string;
  } | null;
  messages: Message[];
  total: number;
  truncated: boolean;
}

/** Evidence used to attach owned child rollouts to their recorded launcher. */
export interface OwnedReaderLinkEvidence {
  tasks?: Task[];
  agentRuns?: AgentRun[];
  relationships?: SessionRelationship[];
}

/** Metadata-only child target used by the bounded reader projection. */
export interface OwnedReaderChildDescriptor {
  provider: ProviderId;
  sessionId: string;
  title: string | null;
  available: boolean;
  link: "explicit" | "inferred";
  parentPartId: string | null;
  detached: boolean;
}

/** Root-owned reader content with metadata-only child navigation targets. */
export interface OwnedReaderProjection {
  rootTree: SessionTree;
  children: OwnedReaderChildDescriptor[];
}

export type ContextChangeSummaryAvailability = "readable" | "recorded-empty" | "not-recorded";

export interface ContextChangeSummary {
  value: string | null;
  availability: ContextChangeSummaryAvailability;
}

export interface ContextChangeSourceEvidence extends EventProvenance {
  /** Raw record position used as a stable reader anchor; it is adapter-derived. */
  sourceOrdinal: number | null;
  sourceOrdinalProvenance: "source-order/derived";
}

export interface ContextChangeContentField {
  label: string;
  value: string;
}

export interface ContextChangeAttachment {
  kind: "image";
  sourcePath: string;
  contentAccess: "metadata-only";
}

export interface ContextChangeRetainedEntry {
  /** Position within the provider-retained group, not a provider record id. */
  sourceOrdinal: number;
  sourceOrdinalProvenance: "source-order/derived";
  kind: "message" | "tool" | "reasoning" | "text" | "other";
  role: string | null;
  fields: ContextChangeContentField[];
  content: string;
  attachments: ContextChangeAttachment[];
  omittedEncryptedFieldPaths: string[];
  omittedEncryptedFieldCount: number;
}

export interface ContextChangeRetainedGroup {
  /** Provider-neutral display label; provider field names stay adapter-owned. */
  label: string;
  entries: ContextChangeRetainedEntry[];
}

export interface ContextChangeResult {
  checkpointId: string;
  source: ContextChangeSourceEvidence;
  summary: ContextChangeSummary;
  groups: ContextChangeRetainedGroup[];
  omitted: {
    encryptedFieldPaths: string[];
    encryptedFieldCount: number;
  };
}

export interface DailyTokenStat {
  /**
   * Token components are mutually exclusive. Provider adapters must remove
   * cached input from input and reasoning from output when the source reports
   * those values as subsets, so charts can safely stack these fields.
   */
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
  role: MessageRole;
  snippet: string;
  timestamp: number;
}

/** Provider-owned revision of one session's normalized search surface. */
export interface SearchIndexSource {
  sessionId: string;
  revision: string;
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

/** Finalized protocol versions built from one provider-owned source snapshot. */
export interface SessionProtocolSnapshots {
  v2: SessionProtocol;
  v3: SessionProtocolV3;
}

export type ContextArtifactContentResult =
  | { status: "readable"; artifactId: string; content: string; format: "markdown" | "plain" }
  | { status: "stale" }
  | { status: "not-found" }
  | { status: "unavailable"; sourceState: ContextArtifactSourceState };

/** Request-local Reader input. Lazy projections share this captured source extent. */
export interface SessionReaderSnapshot {
  session: RawSession;
  messages: Message[];
  revision: string | number;
  inheritedContext: InheritedContextView | null;
  getProtocolSnapshots(): SessionProtocolSnapshots;
  getOwnedReaderProjection(evidence?: OwnedReaderLinkEvidence): OwnedReaderProjection;
}

export interface ReaderCoordinationContent {
  text: string;
  format: "markdown" | "plain";
}

export interface ProviderAdapter {
  id: ProviderId;
  name: string;
  icon: string;
  resumeCommand?: ResumeCommandSpec;
  /** Resolve a provider-owned session selector when it differs from the canonical session ID. */
  getResumeCommandSpec?(sessionId: string): ResumeCommandSpec | null;
  /**
   * Truthful per-domain capability descriptors for the standardized session
   * protocol (events, relationships, tasks, agent runs, context artifacts).
   * A domain may never claim support without a `getSessionProtocol`
   * implementation; absent domains default to support "none".
   */
  protocolCapabilities?: ProtocolCapabilities;
  /**
   * Optional standardized session protocol: typed events with stable
   * sequences, explicit relationships, tasks, agent runs, and metadata-first
   * context artifacts. Returns null when the session is unknown. Providers
   * without native support must not implement this accessor.
   */
  getSessionProtocol?(sessionId: string): SessionProtocol | null;
  /**
   * Optional provider-native Session Protocol v3 snapshot: a finalized v3
   * snapshot whose v2 facts match the finalized v2 snapshot for the same
   * session and whose new domains carry recorded evidence. Providers without
   * native v3 evidence must not implement this accessor; the runtime falls
   * back to the explicit v2-to-v3 upgrade. Returns null when the session is
   * unknown.
   */
  getSessionProtocolV3?(sessionId: string): SessionProtocolV3 | null;
  /**
   * Optional atomic preparation for consumers of both versions. Both finalized
   * snapshots share source revision and canonical identity; raw input is not
   * retained. Existing single-version accessors remain independently usable.
   */
  getSessionProtocolSnapshots?(sessionId: string): SessionProtocolSnapshots | null;
  /** Revision of protocol facts, including optional artifact stores; independent of usage stats. */
  getProtocolRevision?(sessionId: string): string | number;
  /** Read one exact saved artifact version without loading conversation history. */
  getContextArtifactContent?(sessionId: string, artifactId: string): ContextArtifactContentResult;
  /** Inspect retained evidence for one exact artifact without preparing its source history. */
  getContextArtifactEvidence?(sessionId: string, artifactId: string, request: ContextArtifactEvidenceRequest): ContextArtifactEvidenceResult;
  /**
   * Optional on-demand recorded context result. Null means the checkpoint is
   * unknown; a known checkpoint without readable content retains an explicit
   * not-recorded summary and empty groups. Uses this session's owned records.
   */
  getContextChangeResult?(sessionId: string, checkpointId: string): ContextChangeResult | null;
  capabilities?: {
    localManagement?: boolean;
    /** Data path uses the OpenCode SQLite schema accepted by native stats and list queries. */
    openCodeStatsStore?: boolean;
  };
  detect(): boolean;
  getDataPath(): string | null;
  scan(): AsyncIterable<RawSession>;
  /** Optional live Library identity/lineage snapshot; no messages, usage scans, or protocols. */
  getLibrarySessions?(): LibrarySessionMetadata[];
  getSession(sessionId: string): RawSession | Record<string, unknown> | null;
  getMessages(sessionId: string): Message[];
  /** Optional single preparation for the HTML Reader and its pane endpoint. */
  getSessionReaderSnapshot?(sessionId: string): SessionReaderSnapshot | null;
  /** Read one exact observation body from a captured source extent. Null is authoritative unavailable content. */
  getReaderCoordinationContent?(sessionId: string, observation: CoordinationObservation): ReaderCoordinationContent | null;
  /** Fresh revision of only this observation's source and required ownership evidence, not the provider-wide index. */
  getReaderCoordinationContentRevision?(sessionId: string, observation: CoordinationObservation): string;
  /** Explicitly recorded inherited context; readers paginate separately from owned history. */
  getInheritedContext?(sessionId: string): InheritedContextView | null;
  /** Optional bounded reader projection; child bodies remain on-demand. */
  getOwnedReaderProjection?(sessionId: string, evidence?: OwnedReaderLinkEvidence): OwnedReaderProjection | null;
  getTokenStats(days?: number): DailyTokenStat[];
  /** Distinct sessions with recorded usage in the selected token-stat period, when available. */
  getTokenSessionCount?(days?: number, fromDate?: string, toDate?: string): number;
  /** Monotonically changes when a file-backed provider's stats source changes. */
  getStatsRevision?(): string | number;
  searchMessages(query: string, limit?: number, offset?: number): SearchResult[];
  /** Stream normalized matches and their owning session in one file scan. */
  iterateSearchMessages?(query: string): Iterable<{ session: RawSession | Record<string, unknown>; match: SearchResult }>;
  /** List source revisions without loading every message body. Child revisions include any parent evidence used to determine ownership. */
  getSearchIndexSources?(): SearchIndexSource[];
  /** Provider-owned match order when it differs from the normal conversation order. */
  getSearchIndexMessages?(sessionId: string): Message[];
  exportSession?(sessionId: string): unknown;
  getRuntimeEnvironment?(sessionId: string): RuntimeEnvironmentView | null;
  getSystemPrompts?(sessionId: string): unknown;
  getSessionTree?(sessionId: string): unknown;
  getSessionContainer?(sessionId: string): unknown;
  getSessionMetrics?(sessionId: string): unknown;
  getUnavailableReason?(): string | null;
  /** Optional provider-owned diagnostic for detected but unsupported storage backends. */
  getStorageDiagnostic?(): unknown;
}
