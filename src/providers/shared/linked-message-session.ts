import { asNumber } from "./parser.js";
import type { Message, RawSession } from "../interface.js";
import {
  buildMessageSessionTree,
  buildMessageSessionViewsFromTree
} from "./message-session.js";
import type { SessionPartNode, SessionTree } from "./session-tree.js";

type Row = Record<string, any>;

export interface MessageSessionBundle {
  session: RawSession | Row;
  messages: Message[];
}

const SUBAGENT_TOOLS = new Set(["task", "subtask", "spawn_agent", "delegate_task"]);

export function isSubagentToolName(tool: unknown) {
  return SUBAGENT_TOOLS.has(String(tool || "").toLowerCase());
}

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
  "agent_id", "agentId", "agent_path", "agentPath", "session_id", "sessionId", "task_name", "taskName"
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

function attachDirectChildren(tree: SessionTree, children: SessionTree[]) {
  const taskParts = tree.messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "tool" && isSubagentToolName(part.tool));
  const attached = new Set<string>();
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
    attached.add(String(child.session.id));
  }

  tree.detachedChildren = children.filter((child) => !attached.has(String(child.session.id)));
}

export function buildLinkedMessageSessionViews(rootSessionId: string, bundles: MessageSessionBundle[]) {
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
    attachDirectChildren(tree, children);
    return tree;
  };

  const tree = build(rootSessionId);
  return tree ? buildMessageSessionViewsFromTree(tree) : null;
}
