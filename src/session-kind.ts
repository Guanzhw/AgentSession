export const sessionKindFilters = ["all", "work", "analysis"] as const;

export type SessionKindFilter = (typeof sessionKindFilters)[number];

const analysisTitleNeedles = ["analysis", "analyz"];

export function normalizeSessionKindFilter(value: unknown): SessionKindFilter {
  return sessionKindFilters.includes(value as SessionKindFilter)
    ? value as SessionKindFilter
    : "all";
}

export function isAnalysisTitledSession(session: { title?: unknown; slug?: unknown; id?: unknown } | null | undefined) {
  const title = String(session?.title || session?.slug || session?.id || "").toLocaleLowerCase();
  return analysisTitleNeedles.some((needle) => title.includes(needle));
}

export function matchesSessionKind(
  session: { title?: unknown; slug?: unknown; id?: unknown } | null | undefined,
  kind: SessionKindFilter = "all"
) {
  if (kind === "all") {
    return true;
  }

  const analysisTitled = isAnalysisTitledSession(session);
  return kind === "analysis" ? analysisTitled : !analysisTitled;
}

export function analysisTitleSqlCondition(column: string) {
  return analysisTitleNeedles.map(() => `${column} LIKE ?`).join(" OR ");
}

export function analysisTitleSqlParams() {
  return analysisTitleNeedles.map((needle) => `%${needle}%`);
}
