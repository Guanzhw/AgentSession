import { t } from "./i18n.js";

const SESSION_UUID = /^(?:rollout-|agent-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_OPAQUE_ID = /^(?:ses|thread|run)_[a-z0-9_-]{12,}$/i;

function nonEmptyText(value: unknown) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text || null;
}

/**
 * Resolve the title used by the Library card without changing canonical IDs.
 * Viewer-owned custom titles are explicit and therefore win over any provider
 * title, including a value that happens to resemble an ID.
 */
export function resolveLibraryTitle(session: any, untitledLabel = t("library.untitled")) {
  const id = nonEmptyText(session?.id) || "";
  const customTitle = nonEmptyText(session?.custom_title);
  if (customTitle) return customTitle;

  const candidates = [session?.title, session?.slug]
    .map(nonEmptyText)
    .filter((value): value is string => Boolean(value));
  const providerTitle = candidates.find((candidate) => (
    candidate !== id && !SESSION_UUID.test(candidate) && !SESSION_OPAQUE_ID.test(candidate)
  ));
  if (providerTitle) return providerTitle;

  const shortId = id ? id.slice(0, 8) : "";
  return shortId ? `${untitledLabel} · ${shortId}` : untitledLabel;
}
