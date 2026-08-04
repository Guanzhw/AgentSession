/**
 * Safe server-side Markdown rendering for AgentSession.
 *
 * Deliberately dependency-free and conservative:
 * - All HTML input is escaped; there is no raw HTML passthrough.
 * - Only safe URL schemes (http, https, mailto) and relative targets are
 *   allowed in links; unsafe targets render as plain visible text.
 * - GFM tables, task lists, and strikethrough are supported alongside
 *   headings, paragraphs, fenced code, blockquotes, ordered/unordered and
 *   nested lists, horizontal rules, and inline formatting.
 */

const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);
const MAX_BLOCKQUOTE_DEPTH = 6;
const MAX_LIST_DEPTH = 12;

/** Reject javascript:, data:, vbscript:, file:, and friends. Control
 * characters are stripped first so schemes cannot be smuggled through them
 * (e.g. "java\nscript:"). Relative URLs (/x, #frag, ?q, ./x) are allowed. */
function isSafeUrl(raw: string): boolean {
  const cleaned = String(raw || "")
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
    .trim();
  if (!cleaned) return false;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned)?.[1];
  if (!scheme) return true;
  return SAFE_SCHEMES.has(scheme.toLowerCase());
}

export function escapeHtml(text: any): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Inline formatting
// ---------------------------------------------------------------------------

let placeholderCounter = 0;

function inlinePlaceholder(html: string, saved: Map<string, string>): string {
  const marker = `\u0000as:${placeholderCounter++}\u0000`;
  saved.set(marker, html);
  return marker;
}

/** Format one line's inline content. Input is raw (unescaped) text. */
function inlineFormat(text: string): string {
  placeholderCounter = 0;
  const saved = new Map<string, string>();

  // Escape everything first: raw HTML can never survive.
  let working = escapeHtml(text);

  // 1. Protect code spans so markers inside them stay literal.
  working = working.replace(/(`+)([\s\S]*?)\1/g, (_match, _ticks, content) => (
    inlinePlaceholder(`<code>${content}</code>`, saved)
  ));

  // 2. Images become safe links (no external <img> loading), and links are
  // scheme-checked before emphasis can wrap the placeholder.
  working = working.replace(
    /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_match, imgAlt, imgUrl, linkLabel, linkUrl) => {
      const label = imgAlt != null ? imgAlt : linkLabel;
      const rawUrl = imgAlt != null ? imgUrl : linkUrl;
      const decoded = String(rawUrl || "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"');
      if (!isSafeUrl(decoded)) {
        return `${label} (${rawUrl})`;
      }
      return inlinePlaceholder(
        `<a href="${escapeHtml(decoded)}" target="_blank" rel="noopener">${label}</a>`,
        saved
      );
    }
  );

  // 3. Strong.
  working = working.replace(/(\*\*|__)(.+?)\1/g, (_match, mark, content) => (
    inlinePlaceholder(`<strong>${content}</strong>`, saved)
  ));

  // 4. Emphasis (*em* and boundary-safe _em_).
  working = working.replace(/\*([^*\n]+)\*/g, (_match, content) => (
    inlinePlaceholder(`<em>${content}</em>`, saved)
  ));
  working = working.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, (_match, content) => (
    inlinePlaceholder(`<em>${content}</em>`, saved)
  ));

  // 5. Strikethrough.
  working = working.replace(/~~([^~\n]+?)~~/g, (_match, content) => (
    inlinePlaceholder(`<del>${content}</del>`, saved)
  ));

  // 6. Bare http(s) URLs are autolinked.
  working = working.replace(/(https?:\/\/[^\s<>()]+)/g, (match, url) => (
    isSafeUrl(url)
      ? inlinePlaceholder(
        `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${url}</a>`,
        saved
      )
      : match
  ));

  // 7. Restore protected spans recursively because formatting may wrap a
  // link placeholder (for example **bold [link](https://example.com)**).
  let restored = working;
  for (let pass = 0; pass < saved.size + 1; pass += 1) {
    // Preserve marker-shaped source text that was not created by this pass.
    const next = restored.replace(/\u0000as:\d+\u0000/g, (marker) => saved.get(marker) ?? marker);
    if (next === restored) break;
    restored = next;
  }
  return restored;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const LIST_MARKER = /^(\s*)([-+*]|\d{1,9}[.)])\s+(.*)$/;
const TASK_MARKER = /^\[([ xX])\]\s+(.*)$/;

function indentWidth(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") width += 1;
    else if (char === "\t") width += 4;
    else break;
  }
  return width;
}

function isListMarker(line: string): boolean {
  return LIST_MARKER.test(line);
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isDelimiterRow(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isTableStart(lines: string[], index: number): boolean {
  return lines[index].includes("|")
    && index + 1 < lines.length
    && isDelimiterRow(lines[index + 1]);
}

function parseTable(lines: string[], start: number): { html: string; next: number } | null {
  if (!isTableStart(lines, start)) return null;
  const header = splitTableRow(lines[start]);
  const delimiter = splitTableRow(lines[start + 1]);
  const align = delimiter.map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    if (cell.startsWith(":")) return "left";
    return null;
  });
  const alignStyle = (index: number) => (align[index] ? ` style="text-align:${align[index]}"` : "");
  const headerCells = header.map((cell, index) => (
    `<th${alignStyle(index)}>${inlineFormat(cell)}</th>`
  )).join("");

  const rows: string[] = [];
  let i = start + 2;
  while (i < lines.length) {
    if (!lines[i].includes("|")) break;
    if (isDelimiterRow(lines[i]) || isTableStart(lines, i)) break;
    const cells = splitTableRow(lines[i]);
    rows.push(`<tr>${header.map((_, index) => (
      `<td${alignStyle(index)}>${inlineFormat(cells[index] || "")}</td>`
    )).join("")}</tr>`);
    i += 1;
  }

  return {
    html: `<table>\n<thead><tr>${headerCells}</tr></thead>\n<tbody>${rows.join("\n")}</tbody>\n</table>`,
    next: i
  };
}

/**
 * Recursive list parser: same-indent markers continue the list, deeper
 * markers open a nested list inside the current item, continuation lines
 * become paragraphs of the current item, and shallower content ends the
 * list. Task list items are rendered as disabled checkboxes.
 */
function parseList(lines: string[], start: number, depth = 0): { html: string; next: number } {
  const html: string[] = [];
  let listTag: string | null = null;
  let listIndent = -1;
  let i = start;
  let itemHtml: string[] = [];
  let itemClass: string | null = null;

  const closeList = () => {
    if (listTag) {
      html.push(`</${listTag}>`);
      listTag = null;
    }
  };
  const flushItem = () => {
    if (!itemHtml.length) return;
    html.push(`<li${itemClass ? ` class="${itemClass}"` : ""}>${itemHtml.join("")}</li>`);
    itemHtml = [];
    itemClass = null;
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "") {
      // Keep the list open across a blank line when the next non-blank line
      // is a marker at list depth.
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j += 1;
      if (j < lines.length && isListMarker(lines[j]) && indentWidth(lines[j]) >= listIndent) {
        i = j;
        continue;
      }
      break;
    }
    const match = LIST_MARKER.exec(line);
    if (!match) {
      if (listIndent >= 0 && indentWidth(line) >= listIndent) {
        // Lazy/indented continuation paragraph for the current item.
        itemHtml.push(`<p>${inlineFormat(trimmed)}</p>`);
        i += 1;
        continue;
      }
      break;
    }
    const indent = indentWidth(line);
    if (listIndent === -1) listIndent = indent;
    if (indent < listIndent) break;
    if (indent > listIndent) {
      if (depth >= MAX_LIST_DEPTH) {
        itemHtml.push(`<p>${inlineFormat(trimmed)}</p>`);
        i += 1;
        continue;
      }
      const nested = parseList(lines, i, depth + 1);
      itemHtml.push(nested.html);
      i = nested.next;
      continue;
    }
    const isOrdered = /^\d/.test(match[2]);
    const tag = isOrdered ? "ol" : "ul";
    if (listTag !== tag) {
      flushItem();
      closeList();
      listTag = tag;
      const startNumber = isOrdered ? parseInt(match[2], 10) : 1;
      html.push(isOrdered && startNumber !== 1 ? `<ol start="${startNumber}">` : `<${tag}>`);
    }
    flushItem();
    const task = TASK_MARKER.exec(match[3]);
    if (task) {
      const checked = task[1].toLowerCase() === "x";
      itemClass = "task-list-item";
      itemHtml.push(
        `<input type="checkbox" disabled${checked ? " checked" : ""}> ${inlineFormat(task[2])}`
      );
    } else {
      itemHtml.push(inlineFormat(match[3]));
    }
    i += 1;
  }
  flushItem();
  closeList();
  return { html: html.join("\n"), next: i };
}

function isBlockStart(line: string): boolean {
  // Keep these predicates identical to the block parsers below. Treating a
  // four-space-indented marker as a block start here while rejecting it in
  // the parser leaves the cursor unchanged and can loop forever.
  if (/^ {0,3}(`{3,}|~{3,})/.test(line)) return true;
  if (/^ {0,3}#{1,6}\s/.test(line)) return true;
  if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (isListMarker(line)) return true;
  return false;
}

/**
 * Render a Markdown string to sanitized HTML. Falsy input renders as "".
 */
export function renderMarkdown(text: any, depth = 0): string {
  if (text == null) return "";
  const source = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!source.trim()) return "";
  const lines = source.split("\n");
  const html: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Fenced code blocks.
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const mark = fence[1][0];
      const lang = line.slice(fence[0].length).trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length) {
        const close = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
        if (close && close[1][0] === mark && close[1].length >= fence[1].length) {
          i += 1;
          break;
        }
        codeLines.push(lines[i]);
        i += 1;
      }
      html.push(`<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    // GFM tables (a pipe row followed by a delimiter row).
    const table = parseTable(lines, i);
    if (table) {
      html.push(table.html);
      i = table.next;
      continue;
    }

    // ATX headings.
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inlineFormat(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // Horizontal rules.
    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      html.push("<hr>");
      i += 1;
      continue;
    }

    // Blockquotes, with a bounded recursion depth.
    if (/^ {0,3}>/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^ {0,3}> ?/, ""));
        i += 1;
      }
      const inner = depth >= MAX_BLOCKQUOTE_DEPTH
        ? inlineFormat(quoteLines.join("\n"))
        : renderMarkdown(quoteLines.join("\n"), depth + 1);
      html.push(`<blockquote>${inner}</blockquote>`);
      continue;
    }

    // Lists.
    if (isListMarker(line)) {
      const list = parseList(lines, i);
      html.push(list.html);
      i = list.next;
      continue;
    }

    // Paragraphs: consume until a blank line or another block start.
    const paragraphLines: string[] = [];
    while (i < lines.length) {
      const current = lines[i];
      const trimmed = current.trim();
      if (trimmed === "") break;
      if (isBlockStart(current)) break;
      if (isTableStart(lines, i)) break;
      paragraphLines.push(trimmed);
      i += 1;
    }
    html.push(`<p>${inlineFormat(paragraphLines.join(" "))}</p>`);
  }

  return html.join("\n");
}
