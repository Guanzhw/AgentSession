import { escapeHtml } from "../markdown.js";
import { t } from "../i18n.js";
import { resolveLibraryTitle } from "../session-title.js";
import type { LibraryFamilyNode } from "../library-families.js";
import { formatTime, sessionCard, sessionDayKey } from "./components.js";
import { libraryDiscriminatorMarkup, type LibraryDiscriminator } from "./library-disambiguation.js";

export interface LibraryFamilyRenderOptions {
  returnTo: string;
  filters: string;
  providerName: string;
  manageable: boolean;
  discriminator?: LibraryDiscriminator | null;
}

function childrenDisclosure(node: LibraryFamilyNode, options: LibraryFamilyRenderOptions) {
  if (!node.childCount) return "";
  const params = new URLSearchParams(options.filters);
  params.set("parentId", node.session.id);
  params.set("parentProvider", node.session.provider);
  params.set("returnTo", options.returnTo);
  params.delete("offset");
  params.delete("limit");
  const label = t("library.family_children", { count: String(node.childCount) });
  return `<details class="library-family-children" data-library-children data-provider="${escapeHtml(node.session.provider)}" data-session-id="${escapeHtml(node.session.id)}" data-url="/api/library/children?${escapeHtml(params.toString())}" data-next-offset="0">
    <summary>${escapeHtml(label)}</summary>
    <ul class="library-family-branches" data-family-items></ul>
    <p class="library-family-status" data-family-status role="status" hidden></p>
    <button type="button" class="library-family-more" data-family-load hidden>${escapeHtml(t("library.family_more"))}</button>
  </details>`;
}

function contextLabel(node: LibraryFamilyNode) {
  return node.matched ? "" : `<span class="library-family-context">${escapeHtml(t("library.family_context"))}</span>`;
}

export function libraryFamilyEntry(node: LibraryFamilyNode, options: LibraryFamilyRenderOptions) {
  const { session } = node;
  const boundary = node.parentBoundary
    ? `<p class="library-family-boundary">${escapeHtml(t(node.parentBoundary === "cyclic-parent" ? "library.family_cycle" : "library.family_missing_parent"))}</p>` : "";
  return `<section class="library-family" data-library-family data-provider="${escapeHtml(session.provider)}" data-session-id="${escapeHtml(session.id)}" data-day="${escapeHtml(sessionDayKey(node.familyUpdated))}">
    ${sessionCard(session, false, { ...options, provider: session.provider, showProvider: true, showCheckbox: options.manageable && node.matched, showStats: false })}
    ${libraryDiscriminatorMarkup(session, options.discriminator || null)}
    <div class="library-family-relations">${contextLabel(node)}${boundary}${childrenDisclosure(node, options)}</div>
  </section>`;
}

export function libraryFamilyChild(node: LibraryFamilyNode, options: LibraryFamilyRenderOptions) {
  const { session } = node;
  const title = resolveLibraryTitle(session);
  const href = `/${encodeURIComponent(session.provider)}/session/${encodeURIComponent(session.id)}?from=${encodeURIComponent(options.returnTo)}`;
  const checkbox = options.manageable && node.matched
    ? `<label class="card-checkbox-hit-area"><input type="checkbox" class="card-checkbox" data-id="${escapeHtml(session.id)}" data-provider="${escapeHtml(session.provider)}" aria-label="${escapeHtml(t("batch.select_session", { title }))}"></label>` : "";
  return `<li class="library-family-child" data-library-node data-provider="${escapeHtml(session.provider)}" data-session-id="${escapeHtml(session.id)}">
    <div class="library-family-child-heading">
      <div class="library-family-child-title">${checkbox}<a class="library-family-title" href="${escapeHtml(href)}">${escapeHtml(title)}</a></div>
      <time datetime="${new Date(session.time_updated).toISOString()}">${escapeHtml(formatTime(session.time_updated))}</time>
    </div>
    ${libraryDiscriminatorMarkup(session, options.discriminator || { idLabel: session.id.slice(0, 8), excerpt: null })}
    ${contextLabel(node)}
    ${childrenDisclosure(node, options)}
  </li>`;
}
