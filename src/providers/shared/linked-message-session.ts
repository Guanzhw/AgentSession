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

function explicitlyReferencesChild(part: SessionPartNode, child: { session: Row }) {
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

export interface OwnedReaderChildLink {
  session: Row;
  parentPartId: string | null;
  link: "explicit" | "inferred";
  detached: boolean;
}

function evidenceAnchor(
  evidence: SubagentEvidence | undefined,
  child: { session: Row }
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
  child: { session: Row }
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
 * Resolve root-to-child attachment without constructing child trees. This is
 * the bounded reader counterpart to buildLinkedMessageSessionViews: it keeps
 * the same protocol/evidence, explicit-reference, and chronology semantics,
 * while returning metadata-only targets for the reader to load on demand.
 */
export function buildOwnedReaderChildLinks(
  rootSessionId: string,
  tree: SessionTree,
  children: Array<{ session: Row }>,
  evidence?: SubagentEvidence
): OwnedReaderChildLink[] {
  const links = new Map<string, OwnedReaderChildLink>();
  const parts = tree.messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "tool");
  const partsByAnchor = new Map<string, SessionPartNode>();
  for (const part of parts) {
    partsByAnchor.set(part.id, part);
    partsByAnchor.set(part.messageId, part);
    partsByAnchor.set(part.id.replace(/:(tool|reasoning|text)$/, ""), part);
  }

  for (const child of children) {
    const childId = String(child.session.id);
    const anchor = evidenceAnchor(evidence, child)
      || relationshipAnchor(evidence, rootSessionId, child);
    const part = anchor ? partsByAnchor.get(anchor) : null;
    if (part) {
      links.set(childId, { session: child.session, parentPartId: part.id, link: "explicit", detached: false });
      if (!isSubagentTool(part.tool, mergeToolMetadata(part.data?.state?.metadata, part.data?.metadata))) {
        const state = part.data?.state && typeof part.data.state === "object" ? part.data.state : {};
        part.data.state = { ...state, metadata: { ...(state.metadata || {}), subagent: true } };
      }
    }
  }

  const taskParts = parts.filter((part) => isSubagentTool(
    part.tool,
    mergeToolMetadata(part.data?.state?.metadata, part.data?.metadata)
  ));
  const explicitParts = new Set<SessionPartNode>();
  for (const part of taskParts) {
    for (const child of children) {
      const childId = String(child.session.id);
      if (links.has(childId) || !explicitlyReferencesChild(part, child)) continue;
      links.set(childId, { session: child.session, parentPartId: part.id, link: "explicit", detached: false });
      explicitParts.add(part);
    }
  }
  const unmatchedChildren = children
    .filter((child) => !links.has(String(child.session.id)))
    .sort((a, b) => asNumber(a.session.time_created ?? a.session.timeCreated) - asNumber(b.session.time_created ?? b.session.timeCreated));
  // Match the legacy builder: chronology can reuse a part that only received
  // protocol evidence, but not one matched by an explicit child reference.
  const unmatchedParts = taskParts.filter((part) => !explicitParts.has(part));
  for (const child of unmatchedChildren) {
    const childTime = asNumber(child.session.time_created ?? child.session.timeCreated);
    let partIndex = unmatchedParts.findIndex((part) => !childTime || !part.timeStart || part.timeStart <= childTime);
    if (partIndex < 0) partIndex = 0;
    const part = unmatchedParts.splice(partIndex, 1)[0];
    if (!part) continue;
    links.set(String(child.session.id), { session: child.session, parentPartId: part.id, link: "inferred", detached: false });
  }

  for (const child of children) {
    const childId = String(child.session.id);
    if (!links.has(childId)) {
      links.set(childId, { session: child.session, parentPartId: null, link: "inferred", detached: true });
    }
  }
  return [...links.values()];
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
    const links = buildOwnedReaderChildLinks(sessionId, tree, children, evidence);
    const linkById = new Map(links.map((link) => [String(link.session.id), link]));
    for (const child of children) {
      const link = linkById.get(String(child.session.id));
      if (!link) continue;
      if (link.parentPartId) {
        const part = tree.messages.flatMap((message) => message.parts).find((candidate) => candidate.id === link.parentPartId);
        if (!part) continue;
        part.childSessions.push(child);
        if (link.link === "inferred") {
          const inferred = part.inferredChildSessionIds || new Set<string>();
          inferred.add(String(child.session.id));
          part.inferredChildSessionIds = inferred;
        }
      }
    }
    tree.detachedChildren = children.filter((child) => linkById.get(String(child.session.id))?.detached);
    return tree;
  };

  const tree = build(rootSessionId);
  const root = byId.get(rootSessionId);
  return tree && root
    ? buildMessageSessionViewsFromTree(tree, buildAgentLoop(root.messages))
    : null;
}
