import { escapeHtml, renderMarkdown } from "../markdown.js";
import { t } from "../i18n.js";

function formatCount(value: any, prefix = "") {
  const amount = Number(value) || 0;
  return `${prefix}${amount}`;
}

function formatCompactCount(value: any) {
  const amount = Number(value) || 0;
  if (Math.abs(amount) >= 1_000_000) {
    return `${(amount / 1_000_000).toFixed(amount >= 10_000_000 ? 0 : 1)}m`;
  }
  if (Math.abs(amount) >= 1_000) {
    return `${(amount / 1_000).toFixed(amount >= 10_000 ? 0 : 1)}k`;
  }
  return String(amount);
}

function stringifyData(value: any) {
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

function truncate(value: any, limit = 3000) {
  const text = stringifyData(value);
  return text.length > limit ? `${text.slice(0, limit)}\n\n${t("truncated")}` : text;
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

  const totalSeconds = Math.round((end - start) / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function sessionCard(s: any, active = false, { showCheckbox = false, provider = "opencode", manageable = false, showProvider = false, providerName = "", returnTo = "" } = {}) {
  const sessionProvider = s.provider || provider;
  const title = s.title || s.slug || s.id;
  const encodedProvider = encodeURIComponent(sessionProvider);
  const encodedSessionId = encodeURIComponent(s.id);
  const exportFilePrefix = `session-${String(s.id).slice(0, 8)}`;
  const classes = ["session-card"];
  if (active) classes.push("active");
  if (s.starred) classes.push("starred");

  const changedFiles = Number(s.summary_files) || 0;
  const additions = Number(s.summary_additions) || 0;
  const deletions = Number(s.summary_deletions) || 0;
  const stats = [
    changedFiles > 0 ? `<span>${t("card.files").replace("{count}", formatCount(changedFiles))}</span>` : "",
    additions > 0 ? `<span class="additions">+${formatCount(additions)}</span>` : "",
    deletions > 0 ? `<span class="deletions">-${formatCount(deletions)}</span>` : ""
  ].filter(Boolean).join("");
  const statsHtml = stats ? `<footer class="session-card-stats">${stats}</footer>` : "";
  const analysisBadge = s.analysisTitled ? `<span class="session-kind-badge">${t("session.analysis_badge")}</span>` : "";
  const providerBadge = showProvider ? `<span class="session-provider-badge" title="${escapeHtml(sessionProvider)}">${escapeHtml(providerName || sessionProvider)}</span>` : "";
  const detailHref = `/${encodedProvider}/session/${encodeURIComponent(s.id)}${returnTo ? `?from=${encodeURIComponent(returnTo)}` : ""}`;

  const checkboxHtml = showCheckbox
    ? `<input type="checkbox" class="card-checkbox" data-id="${escapeHtml(s.id)}">`
    : "";

  const actionsHtml = manageable ? `
    <div class="card-actions">
      <button class="star-btn ${s.starred ? "starred" : ""}" type="button" data-star-format="icon" data-id="${escapeHtml(s.id)}" title="${s.starred ? t("action.starred") : t("action.star")}" aria-label="${s.starred ? t("action.starred") : t("action.star")}">
        ${s.starred ? "★" : "☆"}
      </button>
      <button class="card-menu-trigger" type="button" data-id="${escapeHtml(s.id)}" title="${t("action.more")}" aria-label="${t("action.more")}">⋮</button>
      <div class="card-menu hidden" data-id="${escapeHtml(s.id)}">
        <button type="button" data-action="rename" data-id="${escapeHtml(s.id)}">${t("menu.rename")}</button>
        <button type="button" data-action="copy-session-id" data-id="${escapeHtml(s.id)}" title="${t("action.copy_session_id")}" aria-label="${t("action.copy_session_id")}">${t("menu.copy_session_id")}</button>
        <a href="/api/${encodedProvider}/session/${encodedSessionId}/export?format=md" download="${escapeHtml(exportFilePrefix)}.md">${t("menu.export_md")}</a>
        <a href="/api/${encodedProvider}/session/${encodedSessionId}/export?format=json" download="${escapeHtml(exportFilePrefix)}.json">${t("menu.export_json")}</a>
        <button type="button" data-action="delete" data-id="${escapeHtml(s.id)}" class="menu-danger">${t("menu.delete")}</button>
      </div>
    </div>
  ` : "";

  return `<article class="${classes.join(" ")}" data-session-id="${escapeHtml(s.id)}">
    ${checkboxHtml}
    <div class="session-card-content">
      <header class="session-card-header">
        <div class="session-card-title-stack">
          <a href="${detailHref}" class="session-card-title-link">
            <h2 class="session-card-title">${escapeHtml(title)}</h2>
          </a>
          ${analysisBadge}
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
  const safeRole = escapeHtml(role || "unknown");
  const model = meta.model ? `<span class="message-model">${escapeHtml(meta.model)}</span>` : "";
  const requestCount = Math.max(0, Number(meta.tokenRequestCount) || (meta.tokens ? 1 : 0));
  const requestCountText = formatCompactCount(requestCount);
  const tokens = formatTokens(meta.tokens, { cacheWarning: meta.cacheWarning, requestCount });
  const requestLabel = requestCount > 1
    ? `<span class="message-token-requests" title="${escapeHtml(t("detail.token_requests_aggregate", { count: requestCountText }))}">${escapeHtml(t("detail.token_requests", { count: requestCountText }))}</span>`
    : "";
  const total = meta.tokens?.total != null
    ? ` title="Total tokens${requestCount > 1 ? ` across ${escapeHtml(requestCountText)} model requests` : ""}: ${escapeHtml(formatCompactCount(meta.tokens.total))}"`
    : "";
  const tokenMarkup = tokens ? `<span class="message-tokens"${total}>${tokens}</span>` : "";
  const time = meta.time ? `<time class="message-time">${escapeHtml(formatTime(meta.time))}</time>` : "";

  return `<header class="message-meta">
      <span class="message-role">${safeRole}</span>
      ${model}
      ${tokenMarkup}
      ${requestLabel}
      ${time}
    </header>`;
}

export function messageBubble(role: any, content: any, meta: any = {}) {
  const safeRole = escapeHtml(role || "unknown");
  const reasoning = meta.reasoning ? `<div class="message-reasoning">${meta.reasoning}</div>` : "";
  const body = role === "assistant"
    ? `<div class="message-body markdown">${renderMarkdown(content || "")}</div>`
    : `<pre class="message-body plain">${escapeHtml(content || "")}</pre>`;

  return `<section class="message message-${safeRole}">
    ${messageHeader(role, meta)}
    ${reasoning}
    ${body}
  </section>`;
}

export function reasoningBlock(content: any, duration = "", partId = "") {
  const text = truncate(content, 6000);
  const safeDuration = duration ? `<span class="reasoning-duration">${escapeHtml(duration)}</span>` : "";

  return `<details class="reasoning-block" ${partId ? `id="part-${escapeHtml(partId)}" data-part-id="${escapeHtml(partId)}"` : ""}>
    <summary aria-label="Toggle reasoning">
      <span class="reasoning-title">Reasoning</span>
      ${safeDuration}
    </summary>
    <div class="reasoning-body markdown">${renderMarkdown(text || "")}</div>
  </details>`;
}

export function toolCallBlock(tool: any, input: any, output: any, status: any, duration: any, partId: any) {
  const inputText = truncate(input);
  const outputText = truncate(output);
  const safeStatus = escapeHtml(status || "unknown");
  const safeDuration = duration ? `<span class="tool-duration">${escapeHtml(duration)}</span>` : "";
  const summary = escapeHtml(toolDescription(tool || "tool", input));

  return `<details class="tool-call tool-status-${safeStatus}" ${partId ? `id="part-${escapeHtml(partId)}" data-part-id="${escapeHtml(partId)}"` : ""}>
    <summary aria-label="${escapeHtml(`Toggle tool call ${tool || "tool"}`)}">
      <span class="tool-name">${summary}</span>
      <span class="tool-status">${safeStatus}</span>
      ${safeDuration}
    </summary>
    <div class="tool-panels">
      <section>
        <h4>${t("tool.input")}</h4>
        <pre>${escapeHtml(inputText)}</pre>
      </section>
      <section>
        <h4>${t("tool.output")}</h4>
        <pre>${escapeHtml(outputText)}</pre>
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
