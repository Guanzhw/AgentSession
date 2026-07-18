export const EMPTY_PROJECT_FILTER = "__opensession_empty_project__";

export function projectFilterValue(projectId: unknown) {
  return projectId == null || String(projectId) === ""
    ? EMPTY_PROJECT_FILTER
    : String(projectId);
}

export function isEmptyProjectFilter(value: unknown) {
  return value === EMPTY_PROJECT_FILTER;
}

export function normalizeCrossProviderProjectPath(value: unknown) {
  let normalized = String(value || "").trim().replaceAll("\\", "/");
  if (!normalized) return "";

  const wslMount = normalized.match(/^\/mnt\/([a-z])(?:\/(.*))?$/i);
  if (wslMount) {
    normalized = `${wslMount[1]}:/${wslMount[2] || ""}`;
  }

  if (/^[a-z]:\/+$/i.test(normalized)) {
    return `${normalized[0].toLowerCase()}:/`;
  }
  normalized = normalized.replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}
