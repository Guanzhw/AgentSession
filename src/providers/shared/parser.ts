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

export function createSnippet(text: any, query: any) {
  if (!text) {
    return "";
  }
  if (!query) {
    return text.slice(0, 160);
  }
  const lowerText = text.toLocaleLowerCase();
  const lowerQuery = query.toLocaleLowerCase();
  const exactIndex = lowerText.indexOf(lowerQuery);
  const firstTerm = splitSearchTerms(query)[0] || lowerQuery;
  const matchIndex = exactIndex >= 0 ? exactIndex : lowerText.indexOf(firstTerm);
  if (matchIndex === -1) {
    return text.slice(0, 160);
  }
  const start = Math.max(0, matchIndex - 40);
  const matchedLength = exactIndex >= 0 ? query.length : firstTerm.length;
  const end = Math.min(text.length, matchIndex + matchedLength + 80);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
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
