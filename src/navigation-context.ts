export type SessionNavigationContext = {
  href: string;
  section: "sessions" | "stats" | "detail";
  day: string | null;
};

const LOCAL_DETAIL_PATH = /^\/([a-z][a-z0-9-]*)\/session\/([^/]+)$/;

function decodeDetailSegment(value: string) {
  try {
    const decoded = decodeURIComponent(value);
    return decoded && !/[\\\u0000-\u001f]/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** Accept only viewer-owned list/stat paths and exact Runtime detail targets. */
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
  const detailMatch = parsed.pathname.match(LOCAL_DETAIL_PATH);
  if (!isSessions && !isStats && !detailMatch) return null;

  if (detailMatch) {
    if ([...parsed.searchParams.keys()].some((key) => !["runtimeLens", "runCursor", "runLimit", "runtimeRun"].includes(key))) return null;
    if (parsed.searchParams.get("runtimeLens") !== "execution") return null;
    const provider = decodeDetailSegment(detailMatch[1]);
    const sessionId = decodeDetailSegment(detailMatch[2]);
    const runId = parsed.searchParams.get("runtimeRun");
    const cursor = parsed.searchParams.get("runCursor");
    const limit = parsed.searchParams.get("runLimit");
    if (!provider || !sessionId || !runId || !runId.trim() || cursor === "" || limit === "") return null;
    if (runId && /[\\\u0000-\u001f]/.test(runId)) return null;
    if (cursor && /[\\\u0000-\u001f]/.test(cursor)) return null;
    return { href: `${parsed.pathname}${parsed.search}${parsed.hash}`, section: "detail", day: null };
  }

  const day = isStats && /^\d{4}-\d{2}-\d{2}$/.test(parsed.searchParams.get("day") || "")
    ? parsed.searchParams.get("day")
    : null;
  return { href: `${parsed.pathname}${parsed.search}${parsed.hash}`, section: isStats ? "stats" : "sessions", day };
}
