import { getIndexDb, type CrossProviderSessionQuery } from "./index-db.js";
import { isEmptyProjectFilter, normalizeCrossProviderProjectPath } from "./project-filter.js";
import type { LibrarySessionMetadata } from "./providers/interface.js";

export interface LibraryFamilyQuery extends CrossProviderSessionQuery {
  /** Complete provider-owned live snapshots replace that provider's indexed rows. */
  liveSessions?: Map<string, LibrarySessionMetadata[]>;
}

export interface LibrarySessionRow {
  id: string;
  provider: string;
  parent_id: string | null;
  title: string | null;
  directory: string | null;
  time_created: number;
  time_updated: number;
  library_evidence: string | null;
}

export interface LibraryFamilyNode {
  session: LibrarySessionRow;
  matched: boolean;
  /** Matching records in this node's subtree, including itself. */
  matchingCount: number;
  /** Direct children retained as paths to matching records. */
  childCount: number;
  totalChildCount: number;
  familyRootId: string;
  familyUpdated: number;
  parentBoundary: "missing-parent" | "hidden-parent" | "cyclic-parent" | null;
}

interface FamilyRecord {
  session: LibrarySessionRow;
  effectiveTitle: string;
  parent: FamilyRecord | null;
  children: FamilyRecord[];
  matched: boolean;
  matchingCount: number;
  subtreeUpdated: number;
  root: FamilyRecord | null;
  parentBoundary: LibraryFamilyNode["parentBoundary"];
}

const identity = (provider: string, id: string) => JSON.stringify([provider, id]);

function prepareFamilies(query: LibraryFamilyQuery) {
  const indexedProviders = query.providers.filter((provider) => !query.liveSessions?.has(provider));
  const rows = getIndexDb().prepare(`
    SELECT id, provider, parent_id, title, directory, time_created, time_updated, library_evidence
    FROM session_index WHERE provider IN (SELECT value FROM json_each(?))
  `).all(JSON.stringify(indexedProviders)) as LibrarySessionRow[];
  for (const provider of query.providers) {
    for (const session of query.liveSessions?.get(provider) || []) {
      rows.push({
        id: session.id, provider: session.provider, parent_id: session.parentId,
        title: session.title, directory: session.directory,
        time_created: session.timeCreated, time_updated: session.timeUpdated,
        library_evidence: null,
      });
    }
  }
  const excluded = new Set((query.excluded || []).map((item) => identity(item.provider, item.id)));
  const included = query.included === undefined ? null
    : new Set(query.included.map((item) => identity(item.provider, item.id)));
  const titles = new Map((query.titleOverrides || []).map((item) => [identity(item.provider, item.id), item.title]));
  const records = new Map<string, FamilyRecord>();
  for (const session of rows) {
    const key = identity(session.provider, session.id);
    if (excluded.has(key)) continue;
    const record: FamilyRecord = {
      session,
      effectiveTitle: titles.get(key) || session.title || session.id,
      parent: null,
      children: [],
      matched: false,
      matchingCount: 0,
      subtreeUpdated: session.time_updated,
      root: null,
      parentBoundary: null,
    };
    records.set(key, record);
  }
  for (const record of records.values()) {
    const { provider, parent_id } = record.session;
    if (parent_id === null) continue;
    const parentKey = identity(provider, parent_id);
    record.parent = records.get(parentKey) || null;
    if (!record.parent) record.parentBoundary = excluded.has(parentKey) ? "hidden-parent" : "missing-parent";
  }

  // Provider parent IDs are external evidence, not a promise of an acyclic tree.
  // Keep cyclic records addressable without inventing an ordering between them.
  const resolved = new Set<FamilyRecord>();
  for (const start of records.values()) {
    const path: FamilyRecord[] = [];
    const positions = new Map<FamilyRecord, number>();
    let current: FamilyRecord | null = start;
    while (current && !resolved.has(current) && !positions.has(current)) {
      positions.set(current, path.length);
      path.push(current);
      current = current.parent;
    }
    if (current && positions.has(current)) {
      for (const cyclic of path.slice(positions.get(current))) {
        cyclic.parent = null;
        cyclic.parentBoundary = "cyclic-parent";
      }
    }
    for (const record of path) resolved.add(record);
  }
  const roots: FamilyRecord[] = [];
  for (const record of records.values()) {
    if (record.parent) record.parent.children.push(record);
    else roots.push(record);
  }

  const term = (query.search || "").toLowerCase();
  const project = normalizeCrossProviderProjectPath(query.project);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cutoff = query.timeRange === "today" ? today.getTime()
    : query.timeRange === "week" ? Date.now() - 7 * 86400000
      : query.timeRange === "month" ? Date.now() - 30 * 86400000 : null;
  for (const record of records.values()) {
    const session = record.session;
    const matchingProject = !query.project || (isEmptyProjectFilter(query.project)
      ? !session.directory
      : normalizeCrossProviderProjectPath(session.directory) === project);
    record.matched = (!term || record.effectiveTitle.toLowerCase().includes(term) || (session.directory || "").toLowerCase().includes(term))
      && matchingProject
      && (cutoff === null || session.time_updated >= cutoff)
      && (included === null || included.has(identity(session.provider, session.id)))
      && (!query.hasSubagent || record.children.length > 0);
    record.matchingCount = record.matched ? 1 : 0;
  }

  const ordered: FamilyRecord[] = [...roots];
  for (let index = 0; index < ordered.length; index += 1) {
    const record = ordered[index];
    record.root = record.parent ? record.parent.root : record;
    ordered.push(...record.children);
  }
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const record = ordered[index];
    if (record.parent) {
      record.parent.matchingCount += record.matchingCount;
      record.parent.subtreeUpdated = Math.max(record.parent.subtreeUpdated, record.subtreeUpdated);
    }
  }
  return { records, roots };
}

function compareRecords(left: FamilyRecord, right: FamilyRecord, sort: string) {
  let difference = 0;
  if (sort === "title-asc" || sort === "title-desc") {
    difference = left.effectiveTitle.localeCompare(right.effectiveTitle, undefined, { sensitivity: "base" });
    if (sort === "title-desc") difference *= -1;
  }
  if (!difference) difference = sort === "updated-asc"
    ? left.subtreeUpdated - right.subtreeUpdated
    : right.subtreeUpdated - left.subtreeUpdated;
  return difference || left.session.provider.localeCompare(right.session.provider) || left.session.id.localeCompare(right.session.id);
}

function familyNode(record: FamilyRecord): LibraryFamilyNode {
  const root = record.root!;
  return {
    session: record.session,
    matched: record.matched,
    matchingCount: record.matchingCount,
    childCount: record.children.filter((child) => child.matchingCount > 0).length,
    totalChildCount: record.children.length,
    familyRootId: root.session.id,
    familyUpdated: root.subtreeUpdated,
    parentBoundary: record.parentBoundary,
  };
}

/** Filter individual records, retain their ancestor paths, then paginate families. */
export function queryLibraryFamilies(query: LibraryFamilyQuery) {
  const { records, roots } = prepareFamilies(query);
  const families = roots.filter((root) => root.matchingCount > 0)
    .sort((left, right) => compareRecords(left, right, query.sort || "updated-desc"));
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 30;
  const selected = families.slice(offset, offset + limit).map(familyNode);
  const matching = [...records.values()].filter((record) => record.matched);
  return {
    families: selected,
    total: families.length,
    offset,
    hasMore: offset + selected.length < families.length,
    overview: {
      totalFamilies: families.length,
      totalSessions: matching.length,
    },
  };
}

/** Return only one visible direct-child page; no transcript or protocol is read. */
export function queryLibraryFamilyChildren(query: LibraryFamilyQuery & { provider: string; parentId: string }) {
  const { records } = prepareFamilies(query);
  const parent = records.get(identity(query.provider, query.parentId));
  const offset = query.offset ?? 0;
  const children = parent?.children.filter((child) => child.matchingCount > 0)
    .sort((left, right) => compareRecords(left, right, query.sort || "updated-desc")) || [];
  const selected = children.slice(offset, offset + (query.limit ?? 20)).map(familyNode);
  return {
    parent: parent && parent.matchingCount > 0 ? familyNode(parent) : null,
    children: selected,
    total: children.length,
    offset,
    hasMore: offset + selected.length < children.length,
  };
}

/** Facets use the same member-level filters, excluding only the project facet itself. */
export function queryLibraryFamilyProjects(query: LibraryFamilyQuery) {
  const { records } = prepareFamilies({ ...query, project: "" });
  const projects = new Map<string, { id: string; label: string; count: number }>();
  for (const record of records.values()) {
    if (!record.matched) continue;
    const directory = record.session.directory || "";
    const key = normalizeCrossProviderProjectPath(directory);
    const existing = projects.get(key);
    if (existing) existing.count += 1;
    else projects.set(key, { id: directory, label: directory || "Unknown project", count: 1 });
  }
  return [...projects.values()].sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}
