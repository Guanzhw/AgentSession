import { buildOpenCodeSessionTree, type SessionPartNode, type SessionTree } from "./session-tree.js";

type Row = Record<string, any>;

export interface PartContainer {
  kind: "part";
  id: string;
  messageId: string;
  sessionId: string;
  partType: string;
  tool: string | null;
  title: string;
  timeStart: number;
  timeEnd: number;
  childSessions: SessionContainer[];
  data: Row;
}

export interface MessageContainer {
  kind: "message";
  id: string;
  sessionId: string;
  role: string;
  title: string;
  timeCreated: number;
  parts: PartContainer[];
  data: Row;
}

export interface SessionContainer {
  kind: "session";
  id: string;
  title: string;
  depth: number;
  attachMode: "root" | "task" | "detached";
  session: Row;
  messages: MessageContainer[];
  detachedChildren: SessionContainer[];
  metrics: SessionTree["metrics"];
}

function compact(value: unknown, fallback = "") {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return fallback;
}

function partTitle(part: SessionPartNode) {
  const data = part.data || {};
  const input = data.state?.input || {};
  return compact(
    data.state?.title
      || input.description
      || input.command
      || input.filePath
      || input.pattern
      || input.url,
    part.tool || part.type || part.id
  );
}

function messageTitle(message: SessionTree["messages"][number]) {
  const textPart = message.parts.find((part) => part.type === "text" && part.data?.text);
  const text = compact(textPart?.data?.text || message.data?.summary || "");
  return text.length > 96 ? `${text.slice(0, 95)}…` : text || `${message.role} message`;
}

function sessionTitle(tree: SessionTree) {
  const session = tree.session || {};
  return session.title || session.slug || session.id || "Untitled session";
}

function convertPart(part: SessionPartNode, depth: number): PartContainer {
  return {
    kind: "part",
    id: part.id,
    messageId: part.messageId,
    sessionId: part.sessionId,
    partType: part.type,
    tool: part.tool,
    title: partTitle(part),
    timeStart: part.timeStart,
    timeEnd: part.timeEnd,
    childSessions: part.childSessions.map((child) => treeToContainer(child, depth + 1, "task")),
    data: part.data
  };
}

export function treeToContainer(tree: SessionTree, depth = 0, attachMode: SessionContainer["attachMode"] = "root"): SessionContainer {
  return {
    kind: "session",
    id: String(tree.session?.id || ""),
    title: sessionTitle(tree),
    depth,
    attachMode,
    session: tree.session,
    messages: tree.messages.map((message) => ({
      kind: "message",
      id: message.id,
      sessionId: message.sessionId,
      role: message.role,
      title: messageTitle(message),
      timeCreated: message.timeCreated,
      parts: message.parts.map((part) => convertPart(part, depth)),
      data: message.data
    })),
    detachedChildren: tree.detachedChildren.map((child) => treeToContainer(child, depth + 1, "detached")),
    metrics: tree.metrics
  };
}

export function buildOpenCodeSessionContainer(sessionId: string, dbPath = undefined): SessionContainer | null {
  const tree = buildOpenCodeSessionTree(sessionId, dbPath);
  return tree ? treeToContainer(tree) : null;
}
