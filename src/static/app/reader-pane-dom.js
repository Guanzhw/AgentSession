/* DOM ownership helpers for panes that share one document. */

const IDREF_ATTRIBUTES = [
  "aria-controls", "aria-describedby", "aria-details", "aria-errormessage",
  "aria-labelledby", "aria-owns", "for"
];

const safeScope = (scope) => {
  return encodeURIComponent(String(scope || "reader"));
};

const ownedElements = (pane) => [pane, ...pane.querySelectorAll("*")]
  .filter((element) => element === pane || element.closest?.("[data-reader-pane]") === pane);

export function scopeReaderPane(pane, scope) {
  if (!pane || pane.dataset.readerDomScope) return pane;
  const prefix = `reader-scope-${safeScope(scope)}`;
  const elements = ownedElements(pane);
  const anchors = new Map();
  elements.forEach((element) => {
    if (!element.id) return;
    const canonical = element.id;
    anchors.set(canonical, `${prefix}--${canonical}`);
    element.dataset.readerCanonicalAnchor = canonical;
  });
  elements.forEach((element) => {
    const canonical = element.dataset.readerCanonicalAnchor;
    if (canonical) element.id = anchors.get(canonical);
    IDREF_ATTRIBUTES.forEach((attribute) => {
      const value = element.getAttribute(attribute);
      if (!value) return;
      element.setAttribute(attribute, value.split(/\s+/).map((part) => anchors.get(part) || part).join(" "));
    });
    const href = element.getAttribute("href") || "";
    if (href.startsWith("#")) {
      let canonical;
      try { canonical = decodeURIComponent(href.slice(1)); } catch { canonical = null; }
      const scoped = canonical && anchors.get(canonical);
      if (scoped) {
        element.dataset.readerCanonicalHref = href;
        element.setAttribute("href", `#${encodeURIComponent(scoped)}`);
      }
    }
  });
  pane.dataset.readerDomScope = prefix;
  return pane;
}

export function readerPaneAnchor(pane, canonicalAnchor) {
  if (!pane || !canonicalAnchor) return null;
  const canonical = String(canonicalAnchor);
  if (pane.dataset.readerCanonicalAnchor === canonical || pane.id === canonical) return pane;
  const escaped = CSS.escape(canonical);
  return [...pane.querySelectorAll(`[data-reader-canonical-anchor="${escaped}"], #${escaped}`)]
    .find((element) => element.closest?.("[data-reader-pane]") === pane) || null;
}

export function unscopeReaderPane(pane) {
  if (!pane?.dataset.readerDomScope) return pane;
  const elements = ownedElements(pane);
  const scopedToCanonical = new Map(elements
    .filter((element) => element.dataset.readerCanonicalAnchor)
    .map((element) => [element.id, element.dataset.readerCanonicalAnchor]));
  elements.forEach((element) => {
    const canonical = element.dataset.readerCanonicalAnchor;
    if (canonical) element.id = canonical;
    IDREF_ATTRIBUTES.forEach((attribute) => {
      const value = element.getAttribute(attribute);
      if (!value) return;
      element.setAttribute(attribute, value.split(/\s+/).map((part) => {
        return scopedToCanonical.get(part) || part;
      }).join(" "));
    });
    if (element.dataset.readerCanonicalHref) {
      element.setAttribute("href", element.dataset.readerCanonicalHref);
      delete element.dataset.readerCanonicalHref;
    }
    delete element.dataset.readerCanonicalAnchor;
  });
  delete pane.dataset.readerDomScope;
  return pane;
}
