import { readFileSync, statSync } from "node:fs";
import type {
  Message,
  RawSession,
  RuntimeEnvironmentView,
  RuntimeExtensionReference
} from "../interface.js";
import { asNumber } from "./parser.js";

type Row = Record<string, any>;

export interface PromptItem {
  kind: string;
  title: string;
  preview: string;
  source: string;
  time: number;
}

export interface PromptSection {
  title: string;
  note: string;
  items: PromptItem[];
}

function compact(value: unknown, limit = 500) {
  if (value == null || value === "") return "";
  let text = "";
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}

function sessionTime(session: RawSession | Row) {
  const row = session as Row;
  return asNumber(row.timeCreated ?? row.time_created);
}

function sourceTime(sourcePath: string | null, fallback: number) {
  if (!sourcePath) return fallback;
  try {
    return statSync(sourcePath).mtimeMs;
  } catch {
    return fallback;
  }
}

function runtimeItem(entry: RuntimeExtensionReference, fallbackTime: number): PromptItem {
  let preview: unknown = {
    note: entry.note,
    sourceType: entry.sourceType,
    available: entry.available,
    capturable: entry.capturable
  };
  if (entry.capturable && entry.sourceType === "file" && entry.sourcePath) {
    try {
      preview = readFileSync(entry.sourcePath, "utf-8");
    } catch (error: any) {
      preview = { note: entry.note, error: error?.message || "Unable to read source" };
    }
  }
  return {
    kind: entry.kind,
    title: entry.name,
    preview: compact(preview),
    source: entry.source,
    time: sourceTime(entry.sourcePath, fallbackTime)
  };
}

function item(kind: string, title: string, preview: unknown, source: string, time: number): PromptItem {
  return { kind, title, preview: compact(preview), source, time: asNumber(time) };
}

/**
 * Build a truthful common prompt-evidence view from normalized session input
 * and currently resolvable runtime sources. It deliberately never claims to
 * reconstruct provider-hidden prompt text.
 */
export function buildResolvedSystemPromptEvidence({
  providerName,
  mode,
  session,
  messages,
  runtimeEnvironment
}: {
  providerName: string;
  mode: string;
  session: RawSession | Row;
  messages: Message[];
  runtimeEnvironment: RuntimeEnvironmentView | null;
}) {
  const time = sessionTime(session);
  const firstUser = messages.find((message) => message.role === "user") || null;
  const firstUserTime = firstUser?.timestamp || time;
  const extensions = runtimeEnvironment?.extensions || [];
  const promptKinds = new Set(["instruction", "rule"]);
  const promptSources = extensions.filter((entry) => promptKinds.has(entry.kind));
  const runtimeSources = extensions.filter((entry) => !promptKinds.has(entry.kind));
  const row = session as Row;
  const sections: PromptSection[] = [
    {
      title: `${providerName} Instructions and Rules`,
      note: "Currently resolvable local instruction and rule sources that can contribute to agent context.",
      items: promptSources.map((entry) => runtimeItem(entry, firstUserTime))
    },
    {
      title: `${providerName} Runtime Extensions`,
      note: "Skills, agents, commands, plugins, hooks, and extensions resolved from the current local environment.",
      items: runtimeSources.map((entry) => runtimeItem(entry, firstUserTime))
    },
    {
      title: "Stored Session Envelope",
      note: "Local session metadata is evidence about the recorded session, not hidden provider prompt text.",
      items: [
        item("session", "Directory", row.directory, "session.directory", time),
        item("session", "Title", row.title, "session.title", time)
      ].filter((entry) => entry.preview)
    },
    {
      title: "First User Boundary",
      note: "This identifies the first user input after the local runtime sources were resolved; it is not itself a system prompt.",
      items: firstUser ? [
        item("first-user", firstUser.id || "first-user", firstUser.content, "message.first-user", firstUserTime)
      ] : []
    }
  ];

  return {
    sessionId: String(row.id),
    mode,
    hiddenPromptStored: false,
    selectedAgent: null,
    note: `${providerName} session data does not prove the hidden provider prompt. This view resolves only current local sources and clearly labels the first-user boundary.`,
    firstUserMessage: firstUser ? {
      id: String(firstUser.id || "first-user"),
      time: firstUserTime,
      preview: compact(firstUser.content)
    } : null,
    sections
  };
}
