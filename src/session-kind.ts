export const sessionKindFilters = ["all"] as const;
export type SessionKindFilter = (typeof sessionKindFilters)[number];
export function normalizeSessionKindFilter(_value: unknown): SessionKindFilter { return "all"; }
export function matchesSessionKind(_session: unknown, _kind: SessionKindFilter = "all") { return true; }
