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

function parseTable(lines: string[], start: number, render = true): { html: string; next: number } | null {
  if (!isTableStart(lines, start)) return null;
  let next = start + 2;
  while (next < lines.length) {
    if (!lines[next].includes("|")) break;
    if (isDelimiterRow(lines[next]) || isTableStart(lines, next)) break;
    next += 1;
  }
  if (!render) return { html: "", next };
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
  while (i < next) {
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

export type MarkdownBlockKind = "blank" | "fence" | "table" | "heading" | "rule" | "blockquote" | "list" | "paragraph";

export interface MarkdownBlockRange {
  kind: MarkdownBlockKind;
  start: number;
  end: number;
}

export const MARKDOWN_BLOCK_SOURCE_LIMIT = 65_536;
const MARKDOWN_PAGE_SOURCE_LIMIT = 6000;
const MARKDOWN_ANALYSIS_CACHE_ENTRIES = 4;
const MARKDOWN_ANALYSIS_CACHE_WEIGHT = 4 * 1024 * 1024;

interface MarkdownAnalysis {
  ranges: MarkdownBlockRange[];
  sourceMode: Map<number, boolean>;
  weight: number;
}

const markdownAnalysisCache = new Map<string, MarkdownAnalysis>();
let markdownAnalysisCacheWeight = 0;

interface SourceLine {
  text: string;
  start: number;
  end: number;
}

function sourceLines(source: string): SourceLine[] {
  if (!source) return [];
  const lines: SourceLine[] = [];
  for (let start = 0; start < source.length;) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline + 1;
    const contentEnd = newline < 0 ? end : newline;
    const raw = source.slice(start, contentEnd);
    lines.push({ text: raw.endsWith("\r") ? raw.slice(0, -1) : raw, start, end });
    start = end;
  }
  return lines;
}

function analyzeMarkdownBlocks(source: string): MarkdownBlockRange[] {
  const records = sourceLines(source);
  const lines = records.map((line) => line.text);
  const ranges: MarkdownBlockRange[] = [];
  const push = (kind: MarkdownBlockKind, start: number, next: number) => {
    ranges.push({ kind, start: records[start].start, end: next < records.length ? records[next].start : source.length });
  };
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "") {
      const start = i;
      while (i < lines.length && lines[i].trim() === "") i += 1;
      push("blank", start, i);
      continue;
    }
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fence) {
      const start = i;
      const mark = fence[1][0];
      i += 1;
      while (i < lines.length) {
        const close = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
        i += 1;
        if (close && close[1][0] === mark && close[1].length >= fence[1].length) break;
      }
      push("fence", start, i);
      continue;
    }
    const table = parseTable(lines, i, false);
    if (table) {
      const start = i;
      i = table.next;
      push("table", start, i);
      continue;
    }
    if (/^ {0,3}#{1,6}\s/.test(lines[i])) {
      push("heading", i, i + 1);
      i += 1;
      continue;
    }
    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(lines[i])) {
      push("rule", i, i + 1);
      i += 1;
      continue;
    }
    if (/^ {0,3}>/.test(lines[i])) {
      const start = i;
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) i += 1;
      push("blockquote", start, i);
      continue;
    }
    if (isListMarker(lines[i])) {
      const start = i;
      i = parseList(lines, i, 0, false).next;
      push("list", start, i);
      continue;
    }
    const start = i;
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i]) && !isTableStart(lines, i)) i += 1;
    push("paragraph", start, i);
  }
  return ranges;
}

function markdownAnalysis(source: string): MarkdownAnalysis {
  const cached = markdownAnalysisCache.get(source);
  if (cached) {
    markdownAnalysisCache.delete(source);
    markdownAnalysisCache.set(source, cached);
    return cached;
  }
  const ranges = analyzeMarkdownBlocks(source);
  const analysis = { ranges, sourceMode: new Map<number, boolean>(), weight: source.length + ranges.length * 24 };
  if (analysis.weight <= MARKDOWN_ANALYSIS_CACHE_WEIGHT) {
    markdownAnalysisCache.set(source, analysis);
    markdownAnalysisCacheWeight += analysis.weight;
    while (markdownAnalysisCache.size > MARKDOWN_ANALYSIS_CACHE_ENTRIES || markdownAnalysisCacheWeight > MARKDOWN_ANALYSIS_CACHE_WEIGHT) {
      const oldest = markdownAnalysisCache.entries().next().value as [string, MarkdownAnalysis] | undefined;
      if (!oldest) break;
      markdownAnalysisCache.delete(oldest[0]);
      markdownAnalysisCacheWeight -= oldest[1].weight;
    }
  }
  return analysis;
}

/** Source ranges for the same block grammar consumed by renderMarkdown(). */
export function markdownBlockRanges(text: any): MarkdownBlockRange[] {
  return markdownAnalysis(String(text ?? "")).ranges;
}

/** Render table body rows using the header/delimiter grammar of their table. */
export function renderMarkdownTableRows(tableSource: string, rowSource: string): string {
  const tableLines = String(tableSource || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (tableLines.length < 2 || !isTableStart(tableLines, 0)) return "";
  const header = splitTableRow(tableLines[0]);
  const delimiter = splitTableRow(tableLines[1]);
  const align = delimiter.map((cell) => cell.startsWith(":") && cell.endsWith(":")
    ? "center"
    : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : null);
  const alignStyle = (index: number) => (align[index] ? ` style="text-align:${align[index]}"` : "");
  const rows = String(rowSource || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
    .filter((line) => line.includes("|") && !isDelimiterRow(line))
    .map((line) => {
      const cells = splitTableRow(line);
      return `<tr>${header.map((_, index) => `<td${alignStyle(index)}>${inlineFormat(cells[index] || "")}</td>`).join("")}</tr>`;
    });
  return `<table><tbody>${rows.join("\n")}</tbody></table>`;
}

/**
 * Recursive list parser: same-indent markers continue the list, deeper
 * markers open a nested list inside the current item, continuation lines
 * become paragraphs of the current item, and shallower content ends the
 * list. Task list items are rendered as disabled checkboxes.
 */
function parseList(lines: string[], start: number, depth = 0, render = true): { html: string; next: number } {
  const html: string[] = [];
  let listTag: string | null = null;
  let listIndent = -1;
  let i = start;
  let itemHtml: string[] = [];
  let itemClass: string | null = null;
  let itemOpen = false;

  const closeList = () => {
    if (listTag) {
      if (render) html.push(`</${listTag}>`);
      listTag = null;
    }
  };
  const flushItem = () => {
    if (!itemOpen) return;
    if (render) html.push(`<li${itemClass ? ` class="${itemClass}"` : ""}>${itemHtml.join("")}</li>`);
    itemHtml = [];
    itemClass = null;
    itemOpen = false;
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
        if (render) itemHtml.push(`<p>${inlineFormat(trimmed)}</p>`);
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
        if (render) itemHtml.push(`<p>${inlineFormat(trimmed)}</p>`);
        i += 1;
        continue;
      }
      const nested = parseList(lines, i, depth + 1, render);
      if (render) itemHtml.push(nested.html);
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
      if (render) html.push(isOrdered && startNumber !== 1 ? `<ol start="${startNumber}">` : `<${tag}>`);
    }
    flushItem();
    itemOpen = true;
    const task = TASK_MARKER.exec(match[3]);
    if (task) {
      const checked = task[1].toLowerCase() === "x";
      itemClass = "task-list-item";
      if (render) itemHtml.push(
        `<input type="checkbox" disabled${checked ? " checked" : ""}> ${inlineFormat(task[2])}`
      );
    } else {
      if (render) itemHtml.push(inlineFormat(match[3]));
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

export type MarkdownContinuation =
  | { kind: "fence" }
  | { kind: "paragraph"; separator: string }
  | { kind: "table" }
  | { kind: "list"; depth: number }
  | { kind: "source" };

export interface MarkdownChunkPlan {
  chunk: string;
  start: number;
  end: number;
  nextOffset: number | null;
  continuation: MarkdownContinuation | null;
  blockStart: number | null;
  sourceMode: boolean;
}

function blockAt(ranges: MarkdownBlockRange[], offset: number): MarkdownBlockRange | null {
  return ranges.find((block) => offset >= block.start && offset < block.end)
    || ranges.find((block) => block.start >= offset)
    || null;
}

function paragraphInner(source: string): string | null {
  return /^<p>([\s\S]*)<\/p>$/.exec(renderMarkdown(source))?.[1] ?? null;
}

function paragraphSeparator(source: string, block: MarkdownBlockRange, cut: number, full = paragraphInner(source.slice(block.start, block.end))): string | null {
  if (cut <= block.start || cut >= block.end) return "";
  const left = paragraphInner(source.slice(block.start, cut));
  const right = paragraphInner(source.slice(cut, block.end));
  if (full == null || left == null || right == null) return null;
  for (const separator of ["", " "]) {
    if (full === `${left}${escapeHtml(separator)}${right}`) return separator;
  }
  return null;
}

function paragraphCut(source: string, block: MarkdownBlockRange, target: number, maximum: number, full = paragraphInner(source.slice(block.start, block.end))) {
  const candidates = [target];
  for (const marker of ["\n", " ", "`", "*", "_", "~", ")"]) {
    const found = source.indexOf(marker, target);
    if (found >= 0 && found < maximum) candidates.push(found + marker.length);
  }
  for (let cut of candidates) {
    if (cut > block.start && /[\uD800-\uDBFF]/.test(source[cut - 1]) && /[\uDC00-\uDFFF]/.test(source[cut])) cut -= 1;
    if (cut <= block.start || cut >= block.end || cut > maximum) continue;
    const separator = paragraphSeparator(source, block, cut, full);
    if (separator != null) return { cut, separator };
  }
  return null;
}

function plainParagraphSeparator(source: string, block: MarkdownBlockRange, cut: number) {
  let runStart = cut;
  while (runStart > block.start && /\s/.test(source[runStart - 1])) runStart -= 1;
  if (runStart === cut) return "";
  const whitespace = source.slice(runStart, cut);
  return /[\r\n]/.test(whitespace) ? " " : whitespace;
}

function plainParagraphCut(source: string, block: MarkdownBlockRange, target: number) {
  let cut = Math.min(target, block.end);
  if (/\s/.test(source[cut] || "") || cut > block.start && /\s/.test(source[cut - 1])) {
    while (cut < block.end && /\s/.test(source[cut])) cut += 1;
  }
  if (cut > block.start && /[\uD800-\uDBFF]/.test(source[cut - 1]) && /[\uDC00-\uDFFF]/.test(source[cut])) cut -= 1;
  return { cut, separator: plainParagraphSeparator(source, block, cut) };
}

function listMarkerRecords(source: string, block: MarkdownBlockRange) {
  const records = sourceLines(source.slice(block.start, block.end));
  const stack: number[] = [];
  return records.flatMap((line) => {
    const match = LIST_MARKER.exec(line.text);
    if (!match) return [];
    const indent = indentWidth(line.text);
    while (stack.length && stack.at(-1)! > indent) stack.pop();
    if (!stack.length || stack.at(-1)! < indent) stack.push(indent);
    return [{ start: block.start + line.start, depth: stack.length - 1 }];
  });
}

function listAscent(source: string, block: MarkdownBlockRange, start: number, depth: number) {
  return listMarkerRecords(source, block).find((marker) => marker.start > start && marker.depth < depth)?.start ?? block.end;
}

function listCut(source: string, block: MarkdownBlockRange, start: number, target: number, maximum: number) {
  const markers = listMarkerRecords(source, block);
  const startDepth = markers.find((marker) => marker.start === start)?.depth ?? 0;
  const ascent = listAscent(source, block, start, startDepth);
  const boundaries = markers.map((marker) => marker.start)
    .filter((position) => position > start && position <= ascent);
  return boundaries.filter((position) => position <= target).at(-1)
    ?? boundaries.find((position) => position > target && position <= maximum)
    ?? null;
}

function tableCut(source: string, block: MarkdownBlockRange, start: number, target: number, maximum: number) {
  const lines = sourceLines(source.slice(block.start, block.end));
  const rowStarts = lines.slice(2).map((line) => block.start + line.start).filter((position) => position > start);
  return rowStarts.filter((position) => position <= target).at(-1)
    ?? rowStarts.find((position) => position > target && position <= maximum)
    ?? null;
}

function fenceCut(source: string, block: MarkdownBlockRange, start: number, target: number) {
  if (start === block.start) {
    const openerEnd = source.indexOf("\n", start);
    if (openerEnd >= 0 && openerEnd + 1 > target) return Math.min(block.end, openerEnd + 1);
  }
  const newline = source.lastIndexOf("\n", target);
  let cut = newline >= start ? newline + 1 : target;
  if (cut > start && /[\uD800-\uDBFF]/.test(source[cut - 1]) && /[\uDC00-\uDFFF]/.test(source[cut])) cut -= 1;
  return Math.min(block.end, Math.max(start + 1, cut));
}

function paragraphHasInlineSyntax(source: string, block: MarkdownBlockRange) {
  return /[`*_~\[\]\\]|https?:\/\//.test(source.slice(block.start, block.end));
}

function hasOversizedWhitespaceRun(source: string, block: MarkdownBlockRange) {
  let run = 0;
  for (let index = block.start; index < block.end; index += 1) {
    run = /\s/.test(source[index]) ? run + 1 : 0;
    if (run > MARKDOWN_BLOCK_SOURCE_LIMIT - MARKDOWN_PAGE_SOURCE_LIMIT) return true;
  }
  return false;
}

function blockRequiresSourceMode(source: string, block: MarkdownBlockRange, analysis: MarkdownAnalysis) {
  const cached = analysis.sourceMode.get(block.start);
  if (cached != null) return cached;
  let required = false;
  if (block.kind === "table") {
    const lines = sourceLines(source.slice(block.start, block.end));
    required = (lines[1]?.end ?? lines[0]?.end ?? 0) > MARKDOWN_BLOCK_SOURCE_LIMIT
      || lines.slice(2).some((line) => line.end - line.start > MARKDOWN_BLOCK_SOURCE_LIMIT);
  } else if (block.kind === "list") {
    const markers = listMarkerRecords(source, block);
    required = markers.some((marker, index) => (markers[index + 1]?.start ?? block.end) - marker.start > MARKDOWN_BLOCK_SOURCE_LIMIT);
  } else if (block.kind === "fence") {
    const delimiters = sourceLines(source.slice(block.start, block.end))
      .filter((line) => /^ {0,3}(`{3,}|~{3,})/.test(line.text))
      .map((line) => line.end - line.start);
    const openerLength = delimiters[0] ?? 0;
    const closingLength = Math.max(0, ...delimiters.slice(1));
    required = block.end - block.start > MARKDOWN_BLOCK_SOURCE_LIMIT
      && (openerLength + MARKDOWN_PAGE_SOURCE_LIMIT > MARKDOWN_BLOCK_SOURCE_LIMIT
        || openerLength + closingLength > MARKDOWN_BLOCK_SOURCE_LIMIT);
  } else if (block.kind === "paragraph" && block.end - block.start > MARKDOWN_BLOCK_SOURCE_LIMIT) {
    required = paragraphHasInlineSyntax(source, block) || hasOversizedWhitespaceRun(source, block);
  } else if (block.kind !== "blank") {
    required = block.end - block.start > MARKDOWN_BLOCK_SOURCE_LIMIT;
  }
  analysis.sourceMode.set(block.start, required);
  return required;
}

function sourcePage(source: string, block: MarkdownBlockRange, start: number, size: number): MarkdownChunkPlan {
  let end = Math.min(block.end, start + size);
  if (end > start && /[\uD800-\uDBFF]/.test(source[end - 1]) && /[\uDC00-\uDFFF]/.test(source[end])) end -= 1;
  return {
    chunk: source.slice(start, end), start, end,
    nextOffset: end < source.length ? end : null,
    continuation: start > block.start ? { kind: "source" } : null,
    blockStart: block.start,
    sourceMode: true
  };
}

function continuationAt(source: string, block: MarkdownBlockRange | null, start: number, paragraphFull?: string | null, plainOversized = false): MarkdownContinuation | null {
  if (!block || start <= block.start) return null;
  if (block.kind === "fence") return { kind: "fence" };
  if (block.kind === "table") return { kind: "table" };
  if (block.kind === "list") {
    const depth = listMarkerRecords(source, block).find((marker) => marker.start === start)?.depth;
    return depth == null ? null : { kind: "list", depth };
  }
  if (block.kind === "paragraph") {
    const separator = plainOversized
      ? plainParagraphSeparator(source, block, start)
      : paragraphSeparator(source, block, start, paragraphFull);
    return separator == null ? null : { kind: "paragraph", separator };
  }
  return null;
}

/** Plan one bounded source page while preserving structural Markdown blocks. */
export function planMarkdownChunk(text: any, offset: number, limit: number): MarkdownChunkPlan {
  const source = String(text ?? "");
  const start = Math.max(0, Math.min(source.length, Number(offset) || 0));
  const size = Math.min(MARKDOWN_PAGE_SOURCE_LIMIT, Math.max(1, Number(limit) || 1));
  const analysis = markdownAnalysis(source);
  const ranges = analysis.ranges;
  const startingBlock = blockAt(ranges, start);
  if (!startingBlock) {
    return { chunk: "", start, end: start, nextOffset: null, continuation: null, blockStart: null, sourceMode: false };
  }
  if (blockRequiresSourceMode(source, startingBlock, analysis)) return sourcePage(source, startingBlock, start, size);
  const paragraphFull = startingBlock?.kind === "paragraph" && start > startingBlock.start
    && startingBlock.end - startingBlock.start <= MARKDOWN_BLOCK_SOURCE_LIMIT
    ? paragraphInner(source.slice(startingBlock.start, startingBlock.end))
    : undefined;
  const plainOversized = startingBlock.kind === "paragraph" && startingBlock.end - startingBlock.start > MARKDOWN_BLOCK_SOURCE_LIMIT;
  const continuation = continuationAt(source, startingBlock, start, paragraphFull, plainOversized);
  let pageLimit = continuation ? Math.min(source.length, startingBlock?.end ?? source.length) : source.length;
  if (startingBlock && continuation?.kind === "list") {
    pageLimit = listAscent(source, startingBlock, start, continuation.depth);
  }
  if (pageLimit - start <= size) {
    const end = pageLimit;
    return { chunk: source.slice(start, end), start, end, nextOffset: end < source.length ? end : null, continuation, blockStart: startingBlock.start, sourceMode: false };
  }
  const target = start + size;
  const maximum = Math.min(pageLimit, start + MARKDOWN_BLOCK_SOURCE_LIMIT);
  const targetBlock = blockAt(ranges, target) || startingBlock;
  if (blockRequiresSourceMode(source, targetBlock, analysis)) {
    if (targetBlock.start <= start) return sourcePage(source, targetBlock, start, size);
    const end = targetBlock.start;
    return { chunk: source.slice(start, end), start, end, nextOffset: end, continuation, blockStart: startingBlock.start, sourceMode: false };
  }
  let end = Math.min(pageLimit, target);
  if (targetBlock.start > start) {
    end = targetBlock.start;
  } else if (target < targetBlock.end) {
    if (targetBlock.kind === "paragraph") {
      const cut = targetBlock.end - targetBlock.start > MARKDOWN_BLOCK_SOURCE_LIMIT
        ? plainParagraphCut(source, targetBlock, target)
        : paragraphCut(source, targetBlock, target, maximum, targetBlock === startingBlock ? paragraphFull : undefined);
      if (!cut) {
        end = targetBlock.start > start && targetBlock.end - start > MARKDOWN_BLOCK_SOURCE_LIMIT
          ? targetBlock.start
          : targetBlock.end;
      } else {
        end = cut.cut;
      }
    } else if (targetBlock.kind === "table") {
      end = tableCut(source, targetBlock, start, target, maximum) ?? targetBlock.start;
    } else if (targetBlock.kind === "list") {
      end = listCut(source, targetBlock, start, target, maximum) ?? targetBlock.start;
    } else if (targetBlock.kind === "fence") {
      end = fenceCut(source, targetBlock, start, target);
    } else if (targetBlock.kind === "blank") {
      end = target;
    } else {
      end = targetBlock.end - start <= MARKDOWN_BLOCK_SOURCE_LIMIT ? targetBlock.end : targetBlock.start;
    }
  }
  if (end <= start) {
    end = targetBlock.end - start <= MARKDOWN_BLOCK_SOURCE_LIMIT ? targetBlock.end : target;
  }
  return {
    chunk: source.slice(start, end), start, end,
    nextOffset: end < source.length ? end : null,
    continuation,
    blockStart: startingBlock.start,
    sourceMode: false
  };
}
