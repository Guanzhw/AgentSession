export const EMPTY_PROJECT_FILTER = "__opensession_empty_project__";

export function projectFilterValue(projectId: unknown) {
  return projectId == null || String(projectId) === ""
    ? EMPTY_PROJECT_FILTER
    : String(projectId);
}

export function isEmptyProjectFilter(value: unknown) {
  return value === EMPTY_PROJECT_FILTER;
}
