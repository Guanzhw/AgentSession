/** Local Lucide assets; license and provenance live beside the SVG files. */
export type UiIconName = "book-open" | "chart-no-axes-column" | "settings-2" | "network"
  | "x" | "moon" | "sun" | "search" | "ellipsis" | "external-link" | "chevron-down" | "star";

export function uiIcon(name: UiIconName): string {
  return `<span class="ui-icon ui-icon-${name}" aria-hidden="true" style="--ui-icon: url('/static/vendor/lucide/${name}.svg')"></span>`;
}
