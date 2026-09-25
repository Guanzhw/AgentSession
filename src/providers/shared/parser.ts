export function asNumber(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

export function parseJson(value: any) {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch (err) {
    console.warn("Failed to parse JSON:", err);
    return value;
  }
}

export function splitSearchTerms(query: unknown): string[] {
  return [...new Set(String(query || "").trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean))];
}

export function matchesSearchQuery(text: unknown, query: unknown): boolean {
  const terms = splitSearchTerms(query);
  if (!terms.length) return false;
  const normalizedText = String(text || "").toLocaleLowerCase();
  return terms.every((term) => normalizedText.includes(term));
}

export function escapeSqlLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

const SEARCH_SNIPPET_LIMIT = 160;
const SEARCH_SNIPPET_OMISSION = "…";

type SearchMatchRange = { start: number; end: number };

function mergeSearchRanges(ranges: SearchMatchRange[]): SearchMatchRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SearchMatchRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function renderSearchWindows(text: string, ranges: SearchMatchRange[]): string {
  const pieces = ranges.map((range) => text.slice(range.start, range.end));
  const prefix = ranges[0].start > 0 ? SEARCH_SNIPPET_OMISSION : "";
  const suffix = ranges[ranges.length - 1].end < text.length ? SEARCH_SNIPPET_OMISSION : "";
  return `${prefix}${pieces.join(SEARCH_SNIPPET_OMISSION)}${suffix}`;
}

function truncateSearchWindows(text: string, ranges: SearchMatchRange[]): string {
  let remaining = SEARCH_SNIPPET_LIMIT - SEARCH_SNIPPET_OMISSION.length;
  let snippet = "";
  for (const range of ranges) {
    const separator = snippet ? SEARCH_SNIPPET_OMISSION : (range.start > 0 ? SEARCH_SNIPPET_OMISSION : "");
    if (separator.length > remaining) break;
    snippet += separator;
    remaining -= separator.length;

    const windowLength = range.end - range.start;
    const visibleLength = Math.min(windowLength, remaining);
    snippet += text.slice(range.start, range.start + visibleLength);
    remaining -= visibleLength;
    if (visibleLength < windowLength || remaining === 0) break;
  }
  return `${snippet}${SEARCH_SNIPPET_OMISSION}`;
}

export function createSnippet(text: any, query: any) {
  if (!text) {
    return "";
  }
  if (!query) {
    return text.slice(0, SEARCH_SNIPPET_LIMIT);
  }
  const lowerText = text.toLocaleLowerCase();
  const lowerQuery = query.toLocaleLowerCase();
  const exactIndex = lowerText.indexOf(lowerQuery);
  const terms = splitSearchTerms(query);
  if (terms.length > 1) {
    if (exactIndex >= 0) {
      const exactStart = Math.max(0, exactIndex - 40);
      const exactEnd = Math.min(text.length, exactIndex + query.length + 80);
      const exactLength = (exactStart > 0 ? 1 : 0) + exactEnd - exactStart + (exactEnd < text.length ? 1 : 0);
      if (exactLength <= SEARCH_SNIPPET_LIMIT) {
        return `${exactStart > 0 ? SEARCH_SNIPPET_OMISSION : ""}${text.slice(exactStart, exactEnd)}${exactEnd < text.length ? SEARCH_SNIPPET_OMISSION : ""}`;
      }
    }

    const ranges: SearchMatchRange[] = [];
    const searchStart = exactIndex >= 0 ? exactIndex : 0;
    for (const term of terms) {
      const start = lowerText.indexOf(term, searchStart);
      if (start < 0) {
        ranges.length = 0;
        break;
      }
      ranges.push({ start, end: start + term.length });
    }
    if (ranges.length === terms.length) {
      ranges.sort((a, b) => a.start - b.start || a.end - b.end);
      const coreRanges = mergeSearchRanges(ranges);
      const matchStart = coreRanges[0].start;
      const matchEnd = coreRanges[coreRanges.length - 1].end;
      const hasPrefix = matchStart > 0;
      const hasSuffix = matchEnd < text.length;
      const availableWidth = SEARCH_SNIPPET_LIMIT - Number(hasPrefix) - Number(hasSuffix);

      if (matchEnd - matchStart <= availableWidth) {
        const contextBudget = availableWidth - (matchEnd - matchStart);
        let before = Math.min(matchStart, 40, Math.floor(contextBudget / 3));
        let after = Math.min(text.length - matchEnd, 80, contextBudget - before);
        let remaining = contextBudget - before - after;
        const moreBefore = Math.min(matchStart - before, remaining);
        before += moreBefore;
        remaining -= moreBefore;
        after += Math.min(text.length - matchEnd - after, remaining);
        const start = matchStart - before;
        const end = matchEnd + after;
        return `${start > 0 ? SEARCH_SNIPPET_OMISSION : ""}${text.slice(start, end)}${end < text.length ? SEARCH_SNIPPET_OMISSION : ""}`;
      }

      for (let radius = 20; radius >= 0; radius -= 1) {
        const windows = mergeSearchRanges(coreRanges.map(({ start, end }) => ({
          start: Math.max(0, start - radius),
          end: Math.min(text.length, end + radius)
        })));
        const snippet = renderSearchWindows(text, windows);
        if (snippet.length <= SEARCH_SNIPPET_LIMIT) return snippet;
      }

      return truncateSearchWindows(text, coreRanges);
    }
  }

  const firstTerm = terms[0] || lowerQuery;
  const matchIndex = exactIndex >= 0 ? exactIndex : lowerText.indexOf(firstTerm);
  if (matchIndex === -1) {
    return text.slice(0, SEARCH_SNIPPET_LIMIT);
  }
  const start = Math.max(0, matchIndex - 40);
  const matchedLength = exactIndex >= 0 ? query.length : firstTerm.length;
  const end = Math.min(text.length, matchIndex + matchedLength + 80);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const snippet = `${prefix}${text.slice(start, end)}${suffix}`;
  if (snippet.length <= SEARCH_SNIPPET_LIMIT) return snippet;
  const visibleLength = SEARCH_SNIPPET_LIMIT - prefix.length - SEARCH_SNIPPET_OMISSION.length;
  return `${prefix}${text.slice(start, start + visibleLength)}${SEARCH_SNIPPET_OMISSION}`;
}

export function mapDataRow(row: any) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    data: parseJson(row.data)
  };
}
