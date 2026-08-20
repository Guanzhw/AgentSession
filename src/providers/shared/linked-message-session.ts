import { asNumber } from "./parser.js";
import type { Message, RawSession } from "../interface.js";
import {
  buildMessageSessionTree,
  buildMessageSessionViewsFromTree
} from "./message-session.js";
import { buildAgentLoop } from "./agent-loop.js";
import { isSubagentTool, mergeToolMetadata } from "./subagent-tools.js";
import type { SessionPartNode, SessionTree } from "./session-tree.js";
import type { AgentRun, SessionRelationship, Task } from "./session-protocol.js";

type Row = Record<string, any>;

export interface MessageSessionBundle {
  session: RawSession | Row;
  messages: Message[];
}

export { isSubagentTool, isSubagentToolName } from "./subagent-tools.js";

function aliasesForSession(session: Row) {
  const metadata = session.metadata && typeof session.metadata === "object" ? session.metadata : {};
  const aliases = [
    session.id,
    metadata.agentId,
    metadata.agentPath,
    metadata.taskName,
    ...(Array.isArray(metadata.aliases) ? metadata.aliases : [])
  ];
  return [...new Set(aliases.filter((value) => typeof value === "string" && value.length >= 6))] as string[];
}

const REFERENCE_KEYS = new Set([
  "agent_id", "agentId", "agent_path", "agentPath", "session_id", "sessionId", "task_id", "taskId", "task_name", "taskName"
]);

function partReferences(part: SessionPartNode) {
  const references = new Set<string>();
  const visit = (value: unknown, key = "") => {
    if (typeof value === "string") {
      if (REFERENCE_KEYS.has(key)) references.add(value);
      if ((key === "output" || key === "metadata") && /^[\[{]/.test(value.trim())) {
        try { visit(JSON.parse(value), key); } catch (err) { console.warn("Failed to parse nested JSON in message output:", err); /* opaque provider output */ }
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey);
  };
  visit(part.data?.state?.input, "input");
  visit(part.data?.state?.output, "output");
  visit(part.data?.metadata, "metadata");
  visit(part.data?.state?.metadata, "metadata");
  return references;
}

function referenceMatchesAlias(reference: string, alias: string) {
  if (reference === alias) return true;
  return alias.endsWith(`/${reference}`) || reference.endsWith(`/${alias}`);
}

function explicitlyReferencesChild(part: SessionPartNode, child: SessionTree) {
  const references = partReferences(part);
  for (const alias of aliasesForSession(child.session)) {
    for (const reference of references) {
      if (referenceMatchesAlias(reference, alias)) return true;
    }
  }
  return false;
}

/**
 * Protocol evidence the shared subagent flow can consume: tasks, agent runs,
 * and relationships for the root session. Only "spawned" relationships and
 * subagent-mode tasks/runs attach children; other relationship kinds (parent,
 * forked, continued, compacted-into, scheduled-run-of) never imply a subagent.
 */
export interface SubagentEvidence {
  tasks?: Task[];
  agentRuns?: AgentRun[];
  relationships?: SessionRelationship[];
}

function evidenceAnchor(
  evidence: SubagentEvidence | undefined,
  child: SessionTree
): string | null {
  if (!evidence) return null;
  const childId = String(child.session.id);
  const runs = (evidence.agentRuns || [])
    .filter((run) => run.childSessionId && String(run.childSessionId) === childId);
  if (runs.length === 0) return null;
  const run = runs[0];
  const task = run.taskId
    ? (evidence.tasks || []).find((candidate) => candidate.id === run.taskId)
    : null;
  return task?.toolCallId || task?.correlationId || run.id || null;
}

function relationshipAnchor(
  evidence: SubagentEvidence | undefined,
  rootSessionId: string,
  child: SessionTree
): string | null {
  if (!evidence) return null;
  const childId = String(child.session.id);
  const relationship = (evidence.relationships || []).find((candidate) => (
    candidate.type === "spawned"
    && String(candidate.fromSessionId) === rootSessionId
    && String(candidate.toSessionId) === childId
  ));
  return relationship?.correlationId || relationship?.provenance.sourceId || null;
}

/**
 * Attach child sessions to the spawn tool part the protocol evidence names:
 * a task whose toolCallId/correlationId matches the part id, or a spawned
 * relationship whose correlationId/sourceId matches it. Falls back to the
 * existing explicit-reference and creation-order pairing when the evidence
 * carries no anchor.
 */
function attachEvidenceChildren(
  rootSessionId: string,
  tree: SessionTree,
  children: SessionTree[],
  evidence: SubagentEvidence | undefined
): Set<string> {
  const attached = new Set<string>();
  if (!evidence) return attached;
  const parts = tree.messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "tool");
  const partsByAnchor = new Map<string, SessionPartNode>();
  for (const part of parts) {
    partsByAnchor.set(part.id, part);
    partsByAnchor.set(part.messageId, part);
    // Agent Loop event ids append a kind suffix to the source message id.
    partsByAnchor.set(part.id.replace(/:(tool|reasoning|text)$/, ""), part);
  }
  const subagentMarkedParts = new Set<SessionPartNode>();

  for (const child of children) {
    const childId = String(child.session.id);
    if (attached.has(childId)) continue;
    const anchor = evidenceAnchor(evidence, child)
      || relationshipAnchor(evidence, rootSessionId, child);
    if (!anchor) continue;
    const part = partsByAnchor.get(anchor);
    if (!part || part.childSessions.some((candidate) => String(candidate.session.id) === childId)) {
      continue;
    }
    part.childSessions.push(child);
    attached.add(childId);
    subagentMarkedParts.add(part);
  }

  // A protocol task/run proves the part launched a subagent even when the
  // part's tool name is not a known launcher label. Mark it so Tree, Runtime,
  // Trace, and rendering consume the normalized fact without provider-id
  // branching.
  for (const part of subagentMarkedParts) {
    const state = part.data?.state && typeof part.data.state === "object" ? part.data.state : {};
    if (isSubagentTool(part.tool, mergeToolMetadata(state.metadata, part.data?.metadata))) continue;
    part.data.state = { ...state, metadata: { ...(state.metadata || {}), subagent: true } };
  }

  return attached;
}

function attachDirectChildren(
  tree: SessionTree,
  children: SessionTree[],
  alreadyAttached: Set<string> | null = null
) {
  const taskParts = tree.messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "tool" && isSubagentTool(
      part.tool,
      mergeToolMetadata(part.data?.state?.metadata, part.data?.metadata)
    ));
  const attached = new Set(alreadyAttached || []);
  const partsWithChildren = new Set<SessionPartNode>();

  for (const part of taskParts) {
    for (const child of children) {
      const childId = String(child.session.id);
      if (attached.has(childId)) continue;
      if (explicitlyReferencesChild(part, child)) {
        part.childSessions.push(child);
        attached.add(childId);
        partsWithChildren.add(part);
      }
    }
  }

  const unmatchedChildren = children
    .filter((child) => !attached.has(String(child.session.id)))
    .sort((a, b) => asNumber(a.session.time_created ?? a.session.timeCreated) - asNumber(b.session.time_created ?? b.session.timeCreated));
  const unmatchedParts = taskParts.filter((part) => !partsWithChildren.has(part));

  // Some providers persist the child relation but omit the spawn call id or
  // task path. In that case creation order is the only source-owned link.
  for (const child of unmatchedChildren) {
    const childTime = asNumber(child.session.time_created ?? child.session.timeCreated);
    let partIndex = unmatchedParts.findIndex((part) => !childTime || !part.timeStart || part.timeStart <= childTime);
    if (partIndex < 0) partIndex = 0;
    const part = unmatchedParts.splice(partIndex, 1)[0];
    if (!part) continue;
    part.childSessions.push(child);
    const inferredChildSessionIds = part.inferredChildSessionIds || new Set<string>();
    inferredChildSessionIds.add(String(child.session.id));
    part.inferredChildSessionIds = inferredChildSessionIds;
    attached.add(String(child.session.id));
  }

  tree.detachedChildren = children.filter((child) => !attached.has(String(child.session.id)));
}

export function buildLinkedMessageSessionViews(
  rootSessionId: string,
  bundles: MessageSessionBundle[],
  evidence?: SubagentEvidence
) {
  const byId = new Map(bundles.map((bundle) => [String(bundle.session.id), bundle]));
  const childrenByParent = new Map<string, MessageSessionBundle[]>();
  for (const bundle of bundles) {
    const session = bundle.session as Row;
    const parentId = session.parentId ?? session.parent_id;
    if (!parentId) continue;
    const key = String(parentId);
    const children = childrenByParent.get(key) || [];
    children.push(bundle);
    childrenByParent.set(key, children);
  }

  const build = (sessionId: string, seen = new Set<string>()): SessionTree | null => {
    if (seen.has(sessionId)) return null;
    const bundle = byId.get(sessionId);
    if (!bundle) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(sessionId);
    const tree = buildMessageSessionTree(bundle.session, bundle.messages);
    const children = (childrenByParent.get(sessionId) || [])
      .map((child) => build(String(child.session.id), nextSeen))
      .filter(Boolean) as SessionTree[];
    const evidenceAttached = attachEvidenceChildren(sessionId, tree, children, evidence);
    attachDirectChildren(tree, children, evidenceAttached);
    return tree;
  };

  const tree = build(rootSessionId);
  const root = byId.get(rootSessionId);
  return tree && root
    ? buildMessageSessionViewsFromTree(tree, buildAgentLoop(root.messages))
    : null;
}
