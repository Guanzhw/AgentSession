import { escapeHtml, renderMarkdown } from "../markdown.js";
import { t, getLocale } from "../i18n.js";
import { anchorId } from "./anchors.js";
import { resolveLibraryTitle } from "../session-title.js";
import { questionAnswerFields, questionAnswersText } from "../providers/shared/question-answers.js";
import type {
  QuestionAnswer,
  ContextChangeResult,
  ContextChangeRetainedEntry,
  ContextChangeRetainedGroup
} from "../providers/interface.js";

function formatCount(value: any, prefix = "") {
  const amount = Number(value) || 0;
  return `${prefix}${amount}`;
}

export function formatCompactCount(value: any) {
  const amount = Number(value) || 0;
  if (Math.abs(amount) >= 1_000_000) {
    return `${(amount / 1_000_000).toFixed(amount >= 10_000_000 ? 0 : 1)}m`;
  }
  if (Math.abs(amount) >= 1_000) {
    return `${(amount / 1_000).toFixed(amount >= 10_000 ? 0 : 1)}k`;
  }
  return String(amount);
}

export function stringifyProgressiveValue(value: any) {
  if (value == null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch (err) {
    console.warn("Failed to stringify value:", err);
    return String(value ?? "");
  }
}

const TOOL_CHUNK_LIMIT = 3000;
const REASONING_CHUNK_LIMIT = 6000;
const MESSAGE_CHUNK_LIMIT = 12000;

type ProgressiveFormat = "markdown" | "plain" | "auto" | "question-answer";

export type ProgressiveField = "text" | "reasoning" | "input" | "output" | "question-answer";

export function progressiveText(value: any, format: ProgressiveFormat): string {
  return format === "question-answer" ? questionAnswersText(value) : stringifyProgressiveValue(value);
}

export interface ContextResultContentIdentity {
  provider: string;
  sessionId: string;
  checkpointId: string;
  target: "summary" | "entry";
  groupIndex?: number;
  entryIndex?: number;
}

export function resolveProgressiveField(data: any, field: ProgressiveField, contentScope = "owned", messageRole = "") {
  if (!data || typeof data !== "object") return null;
  if (field === "question-answer" && data.type === "text" && data.questionAnswers) {
    return { value: data.questionAnswers, format: "question-answer" as const, limit: MESSAGE_CHUNK_LIMIT };
  }
  if (field === "text" && data.type === "text") {
    return {
      value: data.text || "",
      format: data.questionAnswers || (contentScope === "inherited-context" && messageRole === "system") ? "plain" as const : "markdown" as const,
      limit: MESSAGE_CHUNK_LIMIT
    };
  }
  if (field === "reasoning" && data.type === "reasoning") {
    return { value: data.text || "", format: "markdown" as const, limit: REASONING_CHUNK_LIMIT };
  }
  if (data.type !== "tool") return null;
  const state = data.state && typeof data.state === "object" ? data.state : {};
  if (field === "input") {
    return { value: state.input, format: "plain" as const, limit: TOOL_CHUNK_LIMIT };
  }
  if (field === "output") {
    return {
      value: state.status === "error" ? (state.error ?? state.output) : state.output,
      format: "auto" as const,
      limit: TOOL_CHUNK_LIMIT
    };
  }
  return null;
}

function takeChunk(text: string, offset: number, limit: number) {
  const start = Math.max(0, Math.min(text.length, Number(offset) || 0));
  if (text.length - start <= limit) {
    return { chunk: text.slice(start), nextOffset: null };
  }
  const target = start + limit;
  const minimum = start + limit * 0.25;
  let cut = text.lastIndexOf("\n\n", target);
  if (cut < minimum) {
    cut = text.lastIndexOf("\n", target);
    cut = cut < minimum ? target : cut + 1;
  } else {
    cut += 2;
  }
  if (cut <= start) cut = target;
  return { chunk: text.slice(start, cut), nextOffset: cut };
}

/**
 * Render one bounded chunk. The server endpoint reuses this function so later
 * chunks have identical escaping and Markdown decisions without entering the
 * initial page HTML.
 */
function renderProgressiveHtml(text: string, format: ProgressiveFormat, sourceWasString: boolean, chunk: string) {
  const markdown = resolveProgressiveRenderFormat(sourceWasString ? text : null, format) === "markdown";
  return markdown
    ? `<div class="tool-output-body markdown">${renderMarkdown(chunk)}</div>`
    : `<pre>${escapeHtml(chunk)}</pre>`;
}

/** Resolve the exact format used by bounded content rendering for search/UI correspondence. */
export function resolveProgressiveRenderFormat(value: any, format: ProgressiveFormat): "markdown" | "plain" {
  const text = progressiveText(value, format);
  return format === "markdown" || (format === "auto" && typeof value === "string" && looksLikeMarkdown(text))
    ? "markdown"
    : "plain";
}

function renderQuestionAnswerChunk(questionAnswers: QuestionAnswer[], start: number, end: number): string {
  return `<dl class="question-answer-chunk">${questionAnswerFields(questionAnswers).map((field) => {
    const fieldEnd = field.offset + field.text.length;
    if (fieldEnd < start || field.offset >= end || (fieldEnd === start && field.text)) return "";
    const text = field.text.slice(Math.max(0, start - field.offset), end - field.offset);
    return `<dt data-search-exclude>${escapeHtml(t(field.kind === "question" ? "detail.question_answer_question" : "detail.question_answer_answer"))}</dt><dd class="question-answer-value">${escapeHtml(text)}</dd>`;
  }).join("")}</dl>`;
}

export function renderProgressiveContent(
  value: any,
  format: ProgressiveFormat,
  offset = 0,
  limit = TOOL_CHUNK_LIMIT
) {
  const text = progressiveText(value, format);
  const page = takeChunk(text, offset, limit);
  return {
    html: format === "question-answer"
      ? renderQuestionAnswerChunk(value, offset, page.nextOffset ?? text.length)
      : renderProgressiveHtml(text, format, typeof value === "string", page.chunk),
    nextOffset: page.nextOffset,
    totalLength: text.length
  };
}

const CONTEXT_RESULT_CHUNK_LIMIT = 6000;
const CONTEXT_RESULT_PAGE_SIZE = 20;

function contextResultIdentityAttributes(identity: ContextResultContentIdentity) {
  return ` data-content-scope="context-result" data-context-result-target="${escapeHtml(identity.target)}" data-context-result-provider="${escapeHtml(identity.provider)}" data-context-result-session="${escapeHtml(identity.sessionId)}" data-context-result-checkpoint="${escapeHtml(identity.checkpointId)}"${identity.target === "entry" ? ` data-context-result-group="${identity.groupIndex}" data-context-result-entry="${identity.entryIndex}"` : ""}`;
}

function renderContextResultBody(value: any, identity: ContextResultContentIdentity, label: string) {
  const page = renderProgressiveContent(value, "plain", 0, CONTEXT_RESULT_CHUNK_LIMIT);
  if (page.nextOffset == null) {
    return `<div class="context-result-body"${contextResultIdentityAttributes(identity)}>${page.html}</div>`;
  }
  const entryIdentity = identity.target === "entry"
    ? ` data-context-result-group="${identity.groupIndex}" data-context-result-entry="${identity.entryIndex}"`
    : "";
  return `<div class="progressive context-result-body"${contextResultIdentityAttributes(identity)}>
${page.html}
<button type="button" class="progressive-more" data-content-scope="context-result" data-context-result-target="${escapeHtml(identity.target)}" data-context-result-provider="${escapeHtml(identity.provider)}" data-context-result-session="${escapeHtml(identity.sessionId)}" data-context-result-checkpoint="${escapeHtml(identity.checkpointId)}"${entryIdentity} data-field="${identity.target === "summary" ? "summary" : "content"}" data-next-offset="${page.nextOffset}" data-load-error="${escapeHtml(t("progressive.load_failed"))}" aria-label="${escapeHtml(label)}">${escapeHtml(label)}</button>
</div>`;
}

function contextResultEntryMarkup(
  entry: ContextChangeRetainedEntry,
  identity: ContextResultContentIdentity
) {
  const role = entry.role || t("conversation.context_result_role_unknown");
  const source = `${t("conversation.context_result_source_position")}: ${entry.sourceOrdinal} (${entry.sourceOrdinalProvenance})`;
  const omitted = entry.omittedEncryptedFieldCount
    ? `<details class="context-result-omitted"><summary>${escapeHtml(t("conversation.context_result_omitted"))} (${entry.omittedEncryptedFieldCount})</summary><ul>${entry.omittedEncryptedFieldPaths.map((path) => `<li><code>${escapeHtml(path)}</code></li>`).join("")}</ul></details>`
    : "";
  const attachments = (entry.attachments || []).map((attachment) => `<div class="context-result-attachment"><strong>${escapeHtml(t("conversation.context_result_image_not_rendered"))}</strong><span>${escapeHtml(t("conversation.context_result_image_source"))}: <code>${escapeHtml(attachment.sourcePath)}</code></span></div>`).join("");
  return `<article class="context-result-entry" data-context-result-entry data-context-result-group="${identity.groupIndex}" data-context-result-entry-index="${identity.entryIndex}">
    <header class="context-result-entry-header"><strong>${escapeHtml(role)}</strong><span>${escapeHtml(entry.kind)}</span></header>
    ${entry.content ? renderContextResultBody(entry.content, identity, t("progressive.show_more")) : `<p class="context-result-empty">${escapeHtml(t("conversation.context_result_entry_empty"))}</p>`}
    <div class="context-result-entry-meta"><span>${escapeHtml(source)}</span>${entry.fields.length ? `<span>${escapeHtml(t("conversation.context_result_fields"))}: ${escapeHtml(entry.fields.map((field) => field.label).join(", "))}</span>` : ""}</div>
    ${attachments ? `<div class="context-result-attachments">${attachments}</div>` : ""}
    ${omitted}
  </article>`;
}

/** Render one normalized recorded context result page without interpreting provider payloads. */
export function renderContextChangeResult(
  result: ContextChangeResult,
  identity: { provider: string; sessionId: string },
  offset = 0,
  limit = CONTEXT_RESULT_PAGE_SIZE
) {
  const allEntries: Array<{ group: ContextChangeRetainedGroup; groupIndex: number; entry: ContextChangeRetainedEntry; entryIndex: number }> = [];
  result.groups.forEach((group, groupIndex) => group.entries.forEach((entry, entryIndex) => allEntries.push({ group, groupIndex, entry, entryIndex })));
  const page = allEntries.slice(offset, offset + limit);
  const grouped = new Map<number, typeof page>();
  page.forEach((item) => grouped.set(item.groupIndex, [...(grouped.get(item.groupIndex) || []), item]));
  const groupsMarkup = [...grouped.entries()].map(([groupIndex, entries]) => `<section class="context-result-group" data-context-result-group-index="${groupIndex}">
    <h4>${escapeHtml(entries[0].group.label)}</h4>
    <div class="context-result-entry-list">${entries.map(({ entry, entryIndex }) => contextResultEntryMarkup(entry, {
      ...identity,
      checkpointId: result.checkpointId,
      target: "entry",
      groupIndex,
      entryIndex
    })).join("")}</div>
  </section>`).join("");
  const more = offset + page.length < allEntries.length
    ? `<button type="button" class="context-result-more" data-context-result-more data-context-result-provider="${escapeHtml(identity.provider)}" data-context-result-session="${escapeHtml(identity.sessionId)}" data-context-result-checkpoint="${escapeHtml(result.checkpointId)}" data-context-result-offset="${offset + page.length}" data-context-result-limit="${limit}">${escapeHtml(t("conversation.context_result_more"))}</button>`
    : "";
  const pageMarkup = `<div class="context-result-page" data-context-result-page data-context-result-offset="${offset}">
    ${groupsMarkup || `<p class="context-result-empty">${escapeHtml(t("conversation.context_result_no_entries"))}</p>`}
    ${more}
  </div>`;
  if (offset > 0) return { html: pageMarkup, nextOffset: offset + page.length < allEntries.length ? offset + page.length : null, totalEntries: allEntries.length };

  const summaryMarkup = result.summary.availability === "readable" && result.summary.value
    ? `<section class="context-result-summary"><h4>${escapeHtml(t("conversation.context_result_summary"))}</h4>${renderContextResultBody(result.summary.value, {
      ...identity,
      checkpointId: result.checkpointId,
      target: "summary"
    }, t("progressive.show_more"))}</section>`
    : `<p class="context-result-availability context-result-availability-${escapeHtml(result.summary.availability)}">${escapeHtml(result.summary.availability === "recorded-empty" ? t("conversation.context_result_recorded_empty") : t("conversation.context_result_unavailable"))}</p>`;
  const source = result.source;
  const sourceDetails = `<details class="context-result-source"><summary>${escapeHtml(t("conversation.context_result_source"))}</summary><dl>
    <dt>${escapeHtml(t("conversation.context_result_source_type"))}</dt><dd>${escapeHtml(source.sourceType)}</dd>
    <dt>${escapeHtml(t("conversation.context_result_source_fidelity"))}</dt><dd>${escapeHtml(source.fidelity)}</dd>
    ${source.sourceId ? `<dt>${escapeHtml(t("conversation.context_result_source_id"))}</dt><dd><code>${escapeHtml(source.sourceId)}</code></dd>` : ""}
    ${source.sourceOrdinal != null ? `<dt>${escapeHtml(t("conversation.context_result_source_position"))}</dt><dd>${escapeHtml(String(source.sourceOrdinal))} (${escapeHtml(source.sourceOrdinalProvenance)})</dd>` : ""}
  </dl></details>`;
  const omitted = result.omitted.encryptedFieldCount
    ? `<details class="context-result-omitted"><summary>${escapeHtml(t("conversation.context_result_omitted"))} (${result.omitted.encryptedFieldCount})</summary><ul>${result.omitted.encryptedFieldPaths.map((path) => `<li><code>${escapeHtml(path)}</code></li>`).join("")}</ul></details>`
    : "";
  return { html: `<div class="context-result-rendered" data-context-result-rendered data-context-result-checkpoint="${escapeHtml(result.checkpointId)}">
    ${summaryMarkup}
    ${sourceDetails}
    <section class="context-result-groups"><h4>${escapeHtml(t("conversation.context_result_retained"))}</h4>${pageMarkup}</section>
    ${omitted}
  </div>`, nextOffset: offset + page.length < allEntries.length ? offset + page.length : null, totalEntries: allEntries.length };
}

function progressiveContainer(
  value: any,
  format: ProgressiveFormat,
  limit: number,
  label: string,
  partId: string,
  field: ProgressiveField,
  contentScope = "",
  deferInitial = false
) {
  const deferred = deferInitial && Boolean(partId) && value != null && value !== "";
  const page = deferred
    ? { html: "", nextOffset: 0 }
    : renderProgressiveContent(value, format, 0, limit);
  const fieldAttribute = deferInitial ? ` data-content-field="${field}"` : "";
  const fieldClass = deferInitial && field === "reasoning" ? "reasoning-body markdown" : "";
  if (page.nextOffset == null || !partId) {
    return deferInitial
      ? `<div${fieldClass ? ` class="${fieldClass}"` : ""}${fieldAttribute}>${page.html}</div>`
      : page.html;
  }
  return `<div class="${fieldClass ? `${fieldClass} ` : ""}progressive"${fieldAttribute} data-progressive-part-id="${escapeHtml(partId)}" data-progressive-field="${field}" data-content-scope="${escapeHtml(contentScope)}">
${page.html}
<button type="button" class="progressive-more" data-part-id="${escapeHtml(partId)}" data-content-scope="${escapeHtml(contentScope)}" data-field="${field}" data-next-offset="${page.nextOffset}" data-load-error="${escapeHtml(t("progressive.load_failed"))}"${deferred ? ` data-load-initial data-more-label="${escapeHtml(label)}" data-loading-label="${escapeHtml(t("progressive.loading"))}" data-retry-label="${escapeHtml(t("progressive.retry"))}"` : ""}>${escapeHtml(deferred ? t("progressive.load_content") : label)}</button>
</div>`;
}

/** Structured tool output stays raw JSON/code; string output renders as
 * Markdown when it actually contains Markdown constructs. */
function looksLikeMarkdown(text: string): boolean {
  return /\n\s*\n/.test(text)
    || /^#{1,6}\s/m.test(text)
    || /^\s{0,3}([-+*]|\d{1,9}[.)])\s/m.test(text)
    || /^\s{0,3}>\s?/m.test(text)
    || /^```/m.test(text)
    || /^\s*\|.*\|\s*$/m.test(text)
    || /\*\*|~~|!\[|\[[^\]]+\]\([^)]+\)/.test(text);
}

function toolDescription(tool: any, input: any) {
  if (!input || typeof input !== "object") {
    return tool;
  }

  const candidates = [input.filePath, input.command, input.pattern, input.url, input.description];
  const match = candidates.find((value) => typeof value === "string" && value.trim());
  return match ? `${tool} — ${match}` : tool;
}

function tokenChip(label: any, value: any, title: any, className = "") {
  if (value == null || Number(value) === 0) {
    return "";
  }

  const classes = ["token-chip", className].filter(Boolean).join(" ");
  return `<span class="${classes}" title="${escapeHtml(title)}"><span class="token-chip-label">${escapeHtml(label)}</span>${escapeHtml(formatCompactCount(value))}</span>`;
}

function outputTokenCount(tokens: any) {
  const input = Number(tokens.input) || 0;
  const output = Number(tokens.output) || 0;
  const reasoning = Number(tokens.reasoning) || 0;
  const cacheRead = Number(tokens.cache?.read) || 0;
  const cacheWrite = Number(tokens.cache?.write) || 0;
  const total = Number(tokens.total) || 0;
  if (!reasoning) {
    return output;
  }

  // Providers disagree on whether output already includes reasoning. When a
  // total is available, use it to distinguish the two representations.
  const separateTotals = new Set([
    input + output + reasoning,
    input + output + reasoning + cacheRead + cacheWrite
  ]);
  const inclusiveTotals = new Set([
    input + output,
    input + output + cacheRead + cacheWrite
  ]);
  if (total && inclusiveTotals.has(total) && !separateTotals.has(total)) {
    return output;
  }

  return output + reasoning;
}

function inputTokenCount(tokens: any, output: any) {
  const input = Number(tokens.input) || 0;
  const cacheRead = Number(tokens.cache?.read) || 0;
  const cacheWrite = Number(tokens.cache?.write) || 0;
  const total = Number(tokens.total) || 0;

  // The normalized provider records may store cached tokens either inside
  // `input` or alongside it. The request total is the least ambiguous source.
  if (total && total >= output) {
    return total - output;
  }

  return input + cacheRead + cacheWrite;
}

export function formatTokens(tokens: any, { cacheWarning = null, requestCount = 1 }: { cacheWarning?: any; requestCount?: number } = {}) {
  if (!tokens || typeof tokens !== "object") {
    return "";
  }

  const cache = tokens.cache && typeof tokens.cache === "object" ? tokens.cache : {};
  const output = outputTokenCount(tokens);
  const input = inputTokenCount(tokens, output);
  const uncachedInput = Number(tokens.input) || 0;
  const cacheRead = Number(cache.read) || 0;
  const cacheWrite = Number(cache.write) || 0;
  const inputBreakdown = [
    `${formatCompactCount(uncachedInput)} uncached`,
    cacheRead ? `${formatCompactCount(cacheRead)} cache read` : "",
    cacheWrite ? `${formatCompactCount(cacheWrite)} cache write` : ""
  ].filter(Boolean).join(" + ");
  const cachePercent = input > 0 ? cacheRead / input * 100 : 0;
  const cachePrecision = cachePercent > 0 && (cachePercent < 1 || cachePercent > 99) ? 2 : 1;
  const cacheRate = `${cachePercent.toFixed(cachePrecision)}%`;
  const requestCountLabel = Math.max(1, Number(requestCount) || 1);
  const aggregateScope = requestCountLabel > 1
    ? ` across ${formatCompactCount(requestCountLabel)} model requests`
    : " for this request";
  const outputTitle = tokens.reasoning
    ? `Output tokens including reasoning${aggregateScope}: ${formatCompactCount(output)}`
    : `Output tokens${aggregateScope}: ${formatCompactCount(output)}`;
  const cacheTitle = cacheWarning
    ? `Possible cache miss: cached prompt input fell to ${cacheRate} after the previous same-model request was ${cacheWarning.previousRate}. Provider-reported values can also reflect routing or telemetry issues.`
    : `Cached prompt input${aggregateScope}: ${formatCompactCount(cache.read)} of ${formatCompactCount(input)} (${cacheRate} cache hit). Provider-reported values are summed per request.`;
  const pieces = [
    tokenChip("↑", uncachedInput, `Uncached prompt input uploaded${aggregateScope}: ${formatCompactCount(uncachedInput)}. Total prompt input: ${formatCompactCount(input)}${inputBreakdown ? ` (${inputBreakdown})` : ""}`),
    tokenChip("↓", output, outputTitle),
    tokenChip("C", cache.read, cacheTitle, cacheWarning ? "token-chip-cache-warning" : ""),
    tokenChip("W", cache.write, `Cache write tokens: ${formatCompactCount(cache.write)}`)
  ].filter(Boolean);
  if (cacheWarning) {
    pieces.push(`<span class="cache-warning-badge" title="${escapeHtml(cacheTitle)}">! cache miss</span>`);
  }

  if (!pieces.length && tokens.total != null) {
    pieces.push(tokenChip("T", tokens.total, `Total tokens: ${formatCompactCount(tokens.total)}`));
  }

  return pieces.join("");
}

function latestRequestContextLength(meta: any) {
  const requests = Array.isArray(meta?.tokenRequests)
    ? meta.tokenRequests.filter((tokens: unknown) => tokens && typeof tokens === "object")
    : [];
  const tokens = requests.at(-1) || meta?.tokens;
  if (!tokens || typeof tokens !== "object") {
    return null;
  }

  // Providers normalize the request prompt into mutually exclusive uncached,
  // cache-read, and cache-write components. Recombine all three to recover the
  // context supplied to this request without mixing in generated output.
  const contextLength = (Number(tokens.input) || 0)
    + (Number(tokens.cache?.read) || 0)
    + (Number(tokens.cache?.write) || 0);
  return contextLength > 0 ? contextLength : null;
}

export function formatTime(ts: any) {
  const value = Number(ts);
  if (!value) {
    return "";
  }

  const diff = Date.now() - value;
  if (diff < 60_000) return t("time.just_now");
  if (diff < 3_600_000) return t("time.minutes_ago").replace("{n}", Math.floor(diff / 60_000));
  if (diff < 86_400_000) return t("time.hours_ago").replace("{n}", Math.floor(diff / 3_600_000));
  if (diff < 7 * 86_400_000) return t("time.days_ago").replace("{n}", Math.floor(diff / 86_400_000));
  return new Date(value).toLocaleDateString();
}

export function formatDuration(startMs: any, endMs: any) {
  const start = Number(startMs);
  const end = Number(endMs);
  if (!start || !end || end < start) {
    return "";
  }

  return formatDurationMs(end - start) || "0s";
}

/** Compact duration label from a millisecond span (no start/end pair needed). */
type DurationUnitLabels = {
  days: string;
  hours: string;
  minutes: string;
  seconds: string;
};

const ASCII_DURATION_UNITS: DurationUnitLabels = {
  days: "d",
  hours: "h",
  minutes: "m",
  seconds: "s"
};

function formatDurationWithUnits(ms: any, unitLabels: DurationUnitLabels) {
  const totalSeconds = Math.round(Number(ms) / 1000);
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return "";
  }
  const units = [
    [unitLabels.days, 86_400],
    [unitLabels.hours, 3_600],
    [unitLabels.minutes, 60],
    [unitLabels.seconds, 1]
  ] as const;
  let remaining = totalSeconds;
  const parts: string[] = [];
  for (const [label, secondsPerUnit] of units) {
    const amount = Math.floor(remaining / secondsPerUnit);
    if (amount > 0) {
      parts.push(`${amount}${label}`);
      remaining %= secondsPerUnit;
    }
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

export function formatDurationMs(ms: any) {
  return formatDurationWithUnits(ms, ASCII_DURATION_UNITS);
}

/** Compact duration label using the active locale's short unit labels. */
export function formatLocalizedDurationMs(ms: any) {
  return formatDurationWithUnits(ms, {
    days: t("runtime.days_short"),
    hours: t("runtime.hours_short"),
    minutes: t("runtime.minutes_short"),
    seconds: t("runtime.seconds_short")
  });
}

const STATUS_LABEL_KEYS: Record<string, string> = {
  running: "card.status_running",
  blocked: "card.status_blocked",
  waiting_input: "card.status_waiting_input",
  queued: "card.status_queued"
};

/** Local calendar day key (YYYY-MM-DD) used to bucket the library timeline. */
export function sessionDayKey(ts: any) {
  const value = Number(ts) || 0;
  if (!value) {
    return "";
  }
  const date = new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Editorial day heading label for a day key; today and yesterday stay human. */
export function sessionDayLabel(key: string) {
  if (!key) {
    return "";
  }
  const today = sessionDayKey(Date.now());
  const yesterday = sessionDayKey(Date.now() - 86_400_000);
  if (key === today) {
    return t("timeline.today");
  }
  if (key === yesterday) {
    return t("timeline.yesterday");
  }
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(getLocale() === "zh" ? "zh-CN" : "en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  });
}

function listStatChip(label: any, title: any, className = "") {
  const classes = ["stat-chip", className].filter(Boolean).join(" ");
  return `<span class="${classes}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
}

/**
 * Compact, accessible statistic chips for the bounded session list stats.
 * Base values render when known; protocol-specific zero values are omitted.
 * The duration chip explains whether the span is observed activity or the
 * raw created→updated window, so idle gaps are never claimed as active time.
 */
function renderListStatChips(s: any) {
  const listStats = s?.stats;
  if (!listStats || typeof listStats !== "object") {
    return "";
  }
  const chips: string[] = [];
  if (listStats.messageCount != null) {
    chips.push(listStatChip(
      t("card.messages").replace("{count}", formatCompactCount(listStats.messageCount)),
      t("card.messages_help")
    ));
  }
  if (listStats.tokenCount != null && Number(listStats.tokenCount) > 0) {
    chips.push(listStatChip(
      t("card.tokens").replace("{count}", formatCompactCount(listStats.tokenCount)),
      t("card.tokens_help")
    ));
  }
  if (listStats.durationMs != null && Number(listStats.durationMs) >= 1000) {
    const duration = formatDurationMs(listStats.durationMs);
    const help = listStats.durationSource === "protocol"
      ? t("card.observed_duration_help")
      : t("card.recorded_duration_help");
    chips.push(`<span class="stat-chip" title="${escapeHtml(help)}">${escapeHtml(duration)}</span>`);
  }
  if (listStats.protocol && Number(listStats.compactions) > 0) {
    const count = formatCompactCount(listStats.compactions);
    const label = t("card.compactions").replace("{count}", count);
    const title = listStats.lastCompactionAt != null
      ? t("card.compactions_help_last").replace("{count}", count).replace("{time}", formatTime(listStats.lastCompactionAt))
      : t("card.compactions_help").replace("{count}", count);
    chips.push(listStatChip(label, title));
  }
  if (listStats.protocol && Number(listStats.subagentRunCount) > 0) {
    chips.push(listStatChip(
      t("card.subagents").replace("{count}", formatCompactCount(listStats.subagentRunCount)),
      t("card.subagents_help")
    ));
  }
  if (listStats.protocol && Number(listStats.backgroundRunCount) > 0) {
    chips.push(listStatChip(
      t("card.background_runs").replace("{count}", formatCompactCount(listStats.backgroundRunCount)),
      t("card.background_runs_help")
    ));
  }
  for (const status of listStats.activeStatuses || []) {
    const labelKey = STATUS_LABEL_KEYS[status];
    if (!labelKey) continue;
    const label = t(labelKey);
    chips.push(listStatChip(label, t("card.status_help").replace("{status}", label), `stat-chip-${status}`));
  }
  if (listStats.protocol && Number(listStats.contextArtifactCount) > 0) {
    chips.push(listStatChip(
      t("card.artifacts").replace("{count}", formatCompactCount(listStats.contextArtifactCount)),
      t("card.artifacts_help")
    ));
  }
  if (listStats.protocol && listStats.memoryCount != null && Number(listStats.memoryCount) > 0) {
    chips.push(listStatChip(
      t("card.memory").replace("{count}", formatCompactCount(listStats.memoryCount)),
      t("card.memory_help")
    ));
  }
  return chips.join("");
}

export function sessionCard(s: any, active = false, { showCheckbox = false, provider = "opencode", manageable = false, showProvider = true, providerName = "", returnTo = "" } = {}) {
  const sessionProvider = s.provider || provider;
  const title = resolveLibraryTitle(s);
  const encodedProvider = encodeURIComponent(sessionProvider);
  const encodedSessionId = encodeURIComponent(s.id);
  const exportFilePrefix = `session-${String(s.id).slice(0, 8)}`;
  const classes = ["session-card"];
  if (active) classes.push("active");
  if (s.starred) classes.push("starred");
  const dayKey = sessionDayKey(s.time_updated);

  const changedFiles = Number(s.summary_files) || 0;
  const additions = Number(s.summary_additions) || 0;
  const deletions = Number(s.summary_deletions) || 0;
  const stats = [
    changedFiles > 0 ? `<span>${t("card.files").replace("{count}", formatCount(changedFiles))}</span>` : "",
    additions > 0 ? `<span class="additions">+${formatCount(additions)}</span>` : "",
    deletions > 0 ? `<span class="deletions">-${formatCount(deletions)}</span>` : ""
  ].filter(Boolean).join("");
  const protocolStats = renderListStatChips(s);
  const statsHtml = stats || protocolStats ? `<footer class="session-card-stats">${stats ? `<span class="session-card-file-stats">${stats}</span>` : ""}${protocolStats ? `<span class="session-card-signals">${protocolStats}</span>` : ""}</footer>` : "";
  const providerBadge = showProvider ? `<span class="session-provider-badge" title="${escapeHtml(sessionProvider)}">${escapeHtml(providerName || sessionProvider)}</span>` : "";
  const detailHref = `/${encodedProvider}/session/${encodeURIComponent(s.id)}${returnTo ? `?from=${encodeURIComponent(returnTo)}` : ""}`;

  const checkboxHtml = showCheckbox
    ? `<label class="card-checkbox-hit-area"><input type="checkbox" class="card-checkbox" data-id="${escapeHtml(s.id)}" data-provider="${escapeHtml(sessionProvider)}" aria-label="${escapeHtml(t("batch.select_session", { title: String(title) }))}"></label>`
    : "";

  const actionsHtml = manageable ? `
    <div class="card-actions">
      <button class="star-btn ${s.starred ? "starred" : ""}" type="button" data-star-format="icon" data-id="${escapeHtml(s.id)}" data-provider="${escapeHtml(sessionProvider)}" title="${s.starred ? t("action.starred") : t("action.star")}" aria-label="${s.starred ? t("action.starred") : t("action.star")}">
        ${s.starred ? "★" : "☆"}
      </button>
      <button class="card-menu-trigger" type="button" data-id="${escapeHtml(s.id)}" data-provider="${escapeHtml(sessionProvider)}" title="${t("action.more")}" aria-label="${t("action.more")}">⋮</button>
      <div class="card-menu hidden" data-id="${escapeHtml(s.id)}">
        <button type="button" data-action="rename" data-id="${escapeHtml(s.id)}" data-provider="${escapeHtml(sessionProvider)}">${t("menu.rename")}</button>
        <button type="button" data-action="copy-session-id" data-id="${escapeHtml(s.id)}" data-provider="${escapeHtml(sessionProvider)}" title="${t("action.copy_session_id")}" aria-label="${t("action.copy_session_id")}">${t("menu.copy_session_id")}</button>
        <a href="/api/${encodedProvider}/session/${encodedSessionId}/export?format=md" download="${escapeHtml(exportFilePrefix)}.md">${t("menu.export_md")}</a>
        <a href="/api/${encodedProvider}/session/${encodedSessionId}/export?format=json" download="${escapeHtml(exportFilePrefix)}.json">${t("menu.export_json")}</a>
        <button type="button" data-action="delete" data-id="${escapeHtml(s.id)}" data-provider="${escapeHtml(sessionProvider)}" class="menu-danger">${t("menu.delete")}</button>
      </div>
    </div>
  ` : "";

  return `<article class="${classes.join(" ")}" data-session-id="${escapeHtml(s.id)}" data-provider="${escapeHtml(sessionProvider)}" data-day="${escapeHtml(dayKey)}" data-ts="${escapeHtml(String(Number(s.time_updated) || 0))}">
    ${checkboxHtml}
    <div class="session-card-content">
      <header class="session-card-header">
        <div class="session-card-title-stack">
          <a href="${detailHref}" class="session-card-title-link">
            <h2 class="session-card-title">${escapeHtml(title)}</h2>
          </a>
          ${providerBadge}
        </div>
        <time class="session-card-time" datetime="${new Date(Number(s.time_updated) || Date.now()).toISOString()}">${escapeHtml(formatTime(s.time_updated))}</time>
      </header>
      <p class="session-card-directory">${escapeHtml(s.directory || "")}</p>
      ${statsHtml}
    </div>
    ${actionsHtml}
  </article>`;
}

export function messageHeader(role: any, meta: any = {}) {
  const safeRole = escapeHtml(["user", "assistant", "agent"].includes(role) ? t(`detail.role_${role}`) : role || "unknown");
  const model = meta.model ? `<span class="message-model">${escapeHtml(meta.model)}</span>` : "";
  const requestCount = Math.max(0, Number(meta.tokenRequestCount) || (meta.tokens ? 1 : 0));
  const requestCountText = formatCompactCount(requestCount);
  const tokens = formatTokens(meta.tokens, { cacheWarning: meta.cacheWarning, requestCount });
  const requestLabel = requestCount > 1
    ? `<span class="message-token-requests" title="${escapeHtml(t("detail.token_requests_aggregate", { count: requestCountText }))}">${escapeHtml(t("detail.token_requests", { count: requestCountText }))}</span>`
    : "";
  const contextLength = latestRequestContextLength(meta);
  const contextLabel = contextLength == null
    ? ""
    : `<span class="message-context-length" title="${escapeHtml(t("detail.context_length_latest", { count: formatCompactCount(contextLength) }))}">${escapeHtml(t("detail.context_length", { count: formatCompactCount(contextLength) }))}</span>`;
  const total = meta.tokens?.total != null
    ? ` title="Total tokens${requestCount > 1 ? ` across ${escapeHtml(requestCountText)} model requests` : ""}: ${escapeHtml(formatCompactCount(meta.tokens.total))}"`
    : "";
  const tokenMarkup = tokens ? `<span class="message-tokens"${total}>${tokens}</span>` : "";
  const time = meta.time ? `<time class="message-time">${escapeHtml(formatTime(meta.time))}</time>` : "";

  return `<header class="message-meta">
      <span class="message-role">${safeRole}</span>
      ${time}
      ${model || tokenMarkup || contextLabel || requestLabel ? `<details class="message-usage"><summary>${escapeHtml(t("detail.usage_and_model"))}</summary><div class="message-usage-body">${model}${tokenMarkup}${contextLabel}${requestLabel}</div></details>` : ""}
    </header>`;
}

export function messageBubble(role: any, content: any, meta: any = {}) {
  const safeRole = escapeHtml(role || "unknown");
  const reasoning = meta.reasoning ? `<div class="message-reasoning">${meta.reasoning}</div>` : "";
  // Human-authored message roles (user/agent) and assistant text render
  // through the same safe Markdown pipeline; machine roles stay plain. A
  // system message with a part id uses the bounded plain-text continuation
  // path so long inherited context stays readable without changing the
  // established system-message rendering semantics.
  const normalizedRole = String(role || "").toLowerCase();
  const humanRole = ["user", "agent", "assistant"].includes(normalizedRole);
  const progressiveSystem = normalizedRole === "system" && Boolean(meta.partId);
  const body = meta.questionAnswers
    ? `<div class="message-body question-answers" data-content-field="question-answer">${progressiveContainer(
      meta.questionAnswers, "question-answer", MESSAGE_CHUNK_LIMIT, t("progressive.show_more"),
      meta.partId || "", "question-answer", meta.contentScope || ""
    )}</div><details class="question-answer-raw" data-search-exclude><summary>${escapeHtml(t("detail.question_answer_raw"))}</summary>${progressiveContainer(
      content || "", "plain", MESSAGE_CHUNK_LIMIT, t("progressive.show_more"),
      meta.partId || "", "text", meta.contentScope || ""
    )}</details>`
    : humanRole
    ? `<div class="message-body markdown">${progressiveContainer(
      content || "",
      "markdown",
      MESSAGE_CHUNK_LIMIT,
      t("progressive.show_more"),
      meta.partId || "",
      "text",
      meta.contentScope || ""
    )}</div>`
    : progressiveSystem
      ? `<div class="message-body plain">${progressiveContainer(
        content || "",
        "plain",
        MESSAGE_CHUNK_LIMIT,
        t("progressive.show_more"),
        meta.partId || "",
        "text",
        meta.contentScope || ""
      )}</div>`
    : `<pre class="message-body plain">${escapeHtml(content || "")}</pre>`;

  const partAttributes = meta.partId
    ? ` data-part-id="${escapeHtml(meta.partId)}" data-content-scope="${escapeHtml(meta.contentScope || "owned")}"`
    : "";
  return `<section class="message message-${safeRole}"${partAttributes}>
    ${messageHeader(role, meta)}
    ${reasoning}
    ${body}
  </section>`;
}

export function reasoningBlock(content: any, duration = "", partId = "", contentScope = "") {
  const body = progressiveContainer(
    content,
    "markdown",
    REASONING_CHUNK_LIMIT,
    t("progressive.show_more"),
    partId,
    "reasoning",
    contentScope,
    true
  );
  const safeDuration = duration ? `<span class="reasoning-duration">${escapeHtml(duration)}</span>` : "";

  return `<details class="reasoning-block" ${partId ? `id="${escapeHtml(anchorId("part", partId))}" data-part-id="${escapeHtml(partId)}"` : ""}>
    <summary aria-label="Toggle reasoning">
      <span class="reasoning-title">Reasoning</span>
      ${safeDuration}
    </summary>
    ${body}
  </details>`;
}

export function toolCallBlock(tool: any, input: any, output: any, status: any, duration: any, partId: any, contentScope = "") {
  const inputMarkup = progressiveContainer(
    input,
    "plain",
    TOOL_CHUNK_LIMIT,
    t("progressive.show_more"),
    partId,
    "input",
    contentScope,
    true
  );
  const outputMarkup = progressiveContainer(
    output,
    "auto",
    TOOL_CHUNK_LIMIT,
    t("progressive.show_more"),
    partId,
    "output",
    contentScope,
    true
  );
  const safeStatus = escapeHtml(status || "unknown");
  const safeDuration = duration ? `<span class="tool-duration">${escapeHtml(duration)}</span>` : "";
  const summary = escapeHtml(toolDescription(tool || "tool", input));

  return `<details class="tool-call tool-status-${safeStatus}" ${partId ? `id="${escapeHtml(anchorId("part", partId))}" data-part-id="${escapeHtml(partId)}"` : ""}>
    <summary aria-label="${escapeHtml(`Toggle tool call ${tool || "tool"}`)}">
      <span class="tool-name">${summary}</span>
      <span class="tool-status">${safeStatus}</span>
      ${safeDuration}
    </summary>
    <div class="tool-panels">
      <section>
        <h4>${t("tool.input")}</h4>
        ${inputMarkup}
      </section>
      <section>
        <h4>${t("tool.output")}</h4>
        ${outputMarkup}
      </section>
    </div>
  </details>`;
}

export function todoList(todos: any[] = []) {
  if (!todos.length) {
    return "";
  }

  const icons = {
    completed: "✓",
    in_progress: "◉",
    pending: "○"
  };

  const items = todos.map((todo) => {
    const icon = (icons as Record<string, any>)[todo.status] || "○";
    return `<li class="todo-item todo-${escapeHtml(todo.status || "pending")}">
      <span class="todo-icon">${icon}</span>
      <span class="todo-content">${escapeHtml(todo.content || "")}</span>
    </li>`;
  }).join("\n");

  return `<section class="todo-list-wrap">
    <h3>${t("todo.title")}</h3>
    <ul class="todo-list">${items}</ul>
  </section>`;
}

export function pagination(total: any, limit: any, offset: any, baseUrl: any) {
  const totalCount = Number(total) || 0;
  const pageSize = Number(limit) || 1;
  const currentOffset = Number(offset) || 0;

  if (totalCount <= pageSize) {
    return "";
  }

  const currentPage = Math.floor(currentOffset / pageSize) + 1;
  const totalPages = Math.ceil(totalCount / pageSize);
  const pages = [];

  for (let page = 1; page <= totalPages; page += 1) {
    const pageOffset = (page - 1) * pageSize;
    const href = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}offset=${pageOffset}`;
    pages.push(`<a href="${escapeHtml(href)}" class="pagination-link${page === currentPage ? " active" : ""}">${page}</a>`);
  }

  return `<nav class="pagination">${pages.join("")}</nav>`;
}
