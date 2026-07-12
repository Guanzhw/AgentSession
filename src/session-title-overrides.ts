import { matchesSessionKind, normalizeSessionKindFilter, type SessionKindFilter } from "./session-kind.js";

export type SessionTitleOverrides = ReadonlyMap<string, string> | undefined;

export function normalizeSessionTitleOverrides(overrides: SessionTitleOverrides) {
  if (!overrides) return [];
  return [...overrides.entries()]
    .filter(([id, title]) => Boolean(id) && typeof title === "string" && title.trim().length > 0)
    .map(([id, title]) => [id, title] as const);
}

export function getOverrideTitleIds(overrides: SessionTitleOverrides) {
  return normalizeSessionTitleOverrides(overrides).map(([id]) => id);
}

export function serializeSessionTitleOverrides(overrides: SessionTitleOverrides) {
  return JSON.stringify(Object.fromEntries(normalizeSessionTitleOverrides(overrides)));
}

export function getSearchMatchingOverrideIds(overrides: SessionTitleOverrides, search = "") {
  const term = search.trim().toLocaleLowerCase();
  if (!term) return [];
  return normalizeSessionTitleOverrides(overrides)
    .filter(([, title]) => title.toLocaleLowerCase().includes(term))
    .map(([id]) => id);
}

export function getKindMatchingOverrideIds(
  overrides: SessionTitleOverrides,
  sessionKind: SessionKindFilter | string = "all"
) {
  const kind = normalizeSessionKindFilter(sessionKind);
  if (kind === "all") return getOverrideTitleIds(overrides);
  return normalizeSessionTitleOverrides(overrides)
    .filter(([, title]) => matchesSessionKind({ title }, kind))
    .map(([id]) => id);
}
