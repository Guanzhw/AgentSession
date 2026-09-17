const SOURCE_PARAM = "readerSource";
const ANCESTOR_PARAM = "readerAncestor";

function sessionIdentity(url) {
  decodeURI(url.href);
  const match = /^\/([^/]+)\/session\/([^/]+)$/.exec(url.pathname);
  if (!match) return null;
  const provider = decodeURIComponent(match[1]);
  const session = decodeURIComponent(match[2]);
  if (!provider || !session) return null;
  return { provider, session, key: JSON.stringify([provider, session]) };
}

function sessionSource(href, page) {
  const url = new URL(href, page);
  if (url.origin !== page.origin || url.username || url.password
    || url.searchParams.has(SOURCE_PARAM) || url.searchParams.has(ANCESTOR_PARAM)) return null;
  const identity = sessionIdentity(url);
  return identity ? { ...identity, url } : null;
}

export function parseReaderLocation(href, baseHref) {
  try {
    const page = new URL(href, baseHref);
    if ((baseHref && page.origin !== new URL(baseHref).origin)
      || !["http:", "https:"].includes(page.protocol) || page.username || page.password) return null;
    const root = sessionIdentity(page);
    const sources = page.searchParams.getAll(SOURCE_PARAM);
    if (!root || sources.length !== 1 || !sources[0]) return null;
    const target = sessionSource(sources[0], page);
    if (!target) return null;
    const ancestorHrefs = page.searchParams.getAll(ANCESTOR_PARAM);
    if (target.key === root.key && ancestorHrefs.length) return null;
    const seen = new Set([root.key, target.key]);
    const ancestors = [];
    for (const ancestorHref of ancestorHrefs) {
      if (!ancestorHref) return null;
      const ancestor = sessionSource(ancestorHref, page);
      if (!ancestor || seen.has(ancestor.key)) return null;
      seen.add(ancestor.key);
      ancestors.push({ provider: ancestor.provider, session: ancestor.session, href: ancestor.url.href });
    }
    return { source: target.url, ancestors };
  } catch {
    return null;
  }
}

export function stripReaderLocation(url) {
  const result = new URL(url);
  result.searchParams.delete(SOURCE_PARAM);
  result.searchParams.delete(ANCESTOR_PARAM);
  return result;
}

export function createReaderLocation(pageHref, sourceHref, ancestorHrefs = []) {
  const page = stripReaderLocation(pageHref);
  page.searchParams.delete("readerEvent");
  page.hash = "";
  page.searchParams.set(SOURCE_PARAM, new URL(sourceHref, page).href);
  for (const href of ancestorHrefs) page.searchParams.append(ANCESTOR_PARAM, new URL(href, page).href);
  if (!parseReaderLocation(page)) throw new TypeError("Invalid reader location");
  return `${page.pathname}${page.search}${page.hash}`;
}
