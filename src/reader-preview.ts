import { escapeHtml, renderMarkdown } from "./markdown.js";
import { resolveProgressiveField } from "./views/components.js";
import { anchorId } from "./views/anchors.js";
import { t } from "./i18n.js";

/** The preview is deliberately smaller than a transcript message. */
export const READER_PREVIEW_CHARS = 400;

export type ReaderPreviewPhase = "initial" | "final" | "latest";

export interface ReaderPreviewSource {
  provider: string;
  sessionId: string;
  messageId: string;
  partId: string;
  sourceId: string;
  anchor: string;
  href: string;
}

export interface ReaderPreviewEntry {
  available: boolean;
  text: string | null;
  phase: ReaderPreviewPhase | null;
  source: ReaderPreviewSource | null;
  /** Explicitly distinguishes absent readable text from an empty response. */
  reason: "no-readable-content" | null;
}

export interface ReaderPreviewProjection {
  provider: string;
  sessionId: string;
  request: ReaderPreviewEntry;
  reply: ReaderPreviewEntry;
}

interface ReaderPreviewMessage {
  id: string;
  data: {
    role: string;
    presentationPhase?: string;
    contentScope?: string;
  };
}

interface ReaderPreviewPart {
  id: string;
  contentScope?: string;
  data: {
    type: string;
    text?: unknown;
  };
}

/** The normalized owned document returned by getSessionDocument. */
export interface ReaderPreviewDocument {
  messages: ReaderPreviewMessage[];
  partsByMessage: Map<string, ReaderPreviewPart[]>;
}

function unavailable(): ReaderPreviewEntry {
  return {
    available: false,
    text: null,
    phase: null,
    source: null,
    reason: "no-readable-content"
  };
}

function boundedText(value: unknown): string | null {
  // Text is the only normalized value accepted here. Stringifying arbitrary
  // objects would turn unknown/encrypted source fields into invented prose.
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > READER_PREVIEW_CHARS
    ? `${text.slice(0, READER_PREVIEW_CHARS - 1)}…`
    : text;
}

function messageRole(message: ReaderPreviewMessage): string {
  return message.data.role.toLowerCase();
}

function readablePart(document: ReaderPreviewDocument, message: ReaderPreviewMessage): { partId: string; text: string } | null {
  const messageScope = message.data.contentScope || "owned";
  if (messageScope !== "owned") return null;
  const parts = document.partsByMessage.get(message.id)!;
  for (const part of parts) {
    const partId = part.id;
    const partScope = part.contentScope || messageScope;
    if (partScope !== "owned") continue;
    if (part.data.type !== "text") continue;
    const resolved = resolveProgressiveField(part.data, "text", "owned");
    const text = boundedText(resolved?.value);
    if (text) return { partId, text };
  }
  return null;
}

function sourceFor(provider: string, sessionId: string, messageId: string, partId: string): ReaderPreviewSource {
  const anchor = anchorId("part", partId);
  const href = `/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}#${anchor}`;
  return { provider, sessionId, messageId, partId, sourceId: partId, anchor, href };
}

function entryFor(provider: string, sessionId: string, message: ReaderPreviewMessage, part: { partId: string; text: string }, phase: ReaderPreviewPhase): ReaderPreviewEntry {
  return {
    available: true,
    text: part.text,
    phase,
    source: sourceFor(provider, sessionId, String(message.id || ""), part.partId),
    reason: null
  };
}

/**
 * Build the bounded preview from one already-normalized child document.
 * Callers must load only the canonical child document before invoking this.
 */
export function buildReaderPreview(document: ReaderPreviewDocument, provider: string, sessionId: string): ReaderPreviewProjection {
  const messages = document.messages;
  let request: ReaderPreviewEntry | null = null;
  let finalAssistant: ReaderPreviewEntry | null = null;
  let latestAssistant: ReaderPreviewEntry | null = null;
  // Normalized messages are source ordered. Keep the first owned user request,
  // while the newest readable assistant wins unless a recorded final exists.
  for (const message of messages) {
    const role = messageRole(message);
    const part = readablePart(document, message);
    if (!part) continue;
    if (!request && role === "user") request = entryFor(provider, sessionId, message, part, "initial");
    if (role !== "assistant" && role !== "agent") continue;
    const phase = message.data.presentationPhase;
    const entry = entryFor(provider, sessionId, message, part, phase === "final" ? "final" : "latest");
    latestAssistant = entry;
    if (phase === "final") finalAssistant = entry;
  }

  return {
    provider,
    sessionId,
    request: request || unavailable(),
    reply: finalAssistant || latestAssistant || unavailable()
  };
}

function renderEntry(kind: "request" | "reply", entry: ReaderPreviewEntry): string {
  const label = kind === "request"
    ? t("detail.reader_preview_request")
    : entry.phase === "final" ? t("detail.reader_preview_final") : t("detail.reader_preview_latest");
  if (!entry.available || !entry.text || !entry.source) {
    return `<div class="reader-task-preview-entry" data-reader-preview-item="${kind}" data-reader-preview-phase="none"><h4 data-reader-preview-label>${escapeHtml(label)}</h4><span data-reader-preview-state="no-readable-content">${escapeHtml(t("detail.reader_preview_unavailable"))}</span></div>`;
  }
  return `<div class="reader-task-preview-entry" data-reader-preview-item="${kind}" data-reader-preview-phase="${escapeHtml(entry.phase || "latest")}"><h4 data-reader-preview-label>${escapeHtml(label)}</h4><blockquote class="markdown">${renderMarkdown(entry.text)}</blockquote><a data-reader-source data-reader-preview-source data-reader-provider="${escapeHtml(entry.source.provider)}" data-reader-session="${escapeHtml(entry.source.sessionId)}" data-reader-source-id="${escapeHtml(entry.source.sourceId)}" data-reader-anchor="${escapeHtml(entry.source.anchor)}" href="${escapeHtml(entry.source.href)}">${escapeHtml(t("detail.reader_preview_source"))}</a></div>`;
}

/** A page-shell-free, escaped fragment for compact Reader consumers. */
export function renderReaderPreviewHtml(preview: ReaderPreviewProjection): string {
  return `<section class="reader-preview" data-reader-preview data-reader-preview-provider="${escapeHtml(preview.provider)}" data-reader-preview-session="${escapeHtml(preview.sessionId)}">${renderEntry("request", preview.request)}${renderEntry("reply", preview.reply)}</section>`;
}
