export type SessionNavigationContext = {
  href: string;
  section: "sessions" | "stats";
  day: string | null;
};

/** Accept only viewer-owned list/stat paths as session return targets. */
export function parseSessionNavigationContext(value: unknown): SessionNavigationContext | null {
  const text = String(value || "");
  if (!text || text.length > 2048 || !text.startsWith("/") || text.startsWith("//") || /[\\\u0000-\u001f]/.test(text)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(text, "http://agentsession.local");
  } catch {
    return null;
  }
  if (parsed.origin !== "http://agentsession.local") return null;

  const isSessions = parsed.pathname === "/sessions" || /^\/[a-z][a-z0-9-]*\/?$/.test(parsed.pathname);
  const isStats = parsed.pathname === "/stats" || /^\/[a-z][a-z0-9-]*\/stats$/.test(parsed.pathname);
  if (!isSessions && !isStats) return null;

  const day = isStats && /^\d{4}-\d{2}-\d{2}$/.test(parsed.searchParams.get("day") || "")
    ? parsed.searchParams.get("day")
    : null;
  return { href: `${parsed.pathname}${parsed.search}${parsed.hash}`, section: isStats ? "stats" : "sessions", day };
}
