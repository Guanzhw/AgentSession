import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-library-families-"));
process.env.AGENTSESSION_META_PATH = path.join(temp, "meta.db");
const { initConfig } = await import("../dist/src/config.js");
initConfig([]);
const { clearIndex, closeIndexDb, upsertIndex, getCrossProviderSessions } = await import("../dist/src/index-db.js");
const { queryLibraryFamilies, queryLibraryFamilyChildren, queryLibraryFamilyProjects } = await import("../dist/src/library-families.js");

test.beforeEach(() => clearIndex());
test.after(() => {
  closeIndexDb();
  rmSync(temp, { recursive: true, force: true });
});

const NOW = Date.now();
const base = { providers: ["codex"] };
function row(id, parentId = null, extra = {}) {
  return { id, parentId, title: id, directory: "D:\\project", timeCreated: NOW - 1000,
    timeUpdated: NOW - 500, messageCount: 2, tokenCount: 10, ...extra };
}
const ids = (nodes) => nodes.map((node) => node.session.id);

test("library groups canonical multi-level families before paging without changing flat accessors", () => {
  upsertIndex("codex", [row("root", null, { timeUpdated: NOW - 100 }), row("child", "root"),
    row("grandchild", "child", { timeUpdated: NOW }), row("other", null, { timeUpdated: NOW - 50 })]);
  const first = queryLibraryFamilies({ ...base, limit: 1 });
  assert.deepEqual(ids(first.families), ["root"]);
  assert.equal(first.total, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.families[0].familyUpdated, NOW);
  assert.equal(first.families[0].session.time_updated, NOW - 100, "source timestamp is unchanged");
  assert.equal(first.families[0].matchingCount, 3);
  assert.equal(first.families[0].childCount, 1);
  assert.deepEqual(first.overview, { totalFamilies: 2, totalSessions: 4 });
  assert.deepEqual(ids(queryLibraryFamilies({ ...base, limit: 1, offset: 1 }).families), ["other"]);
  const child = queryLibraryFamilyChildren({ ...base, provider: "codex", parentId: "root" });
  assert.deepEqual(ids(child.children), ["child"]);
  assert.equal(child.children[0].familyRootId, "root");
  assert.deepEqual(ids(queryLibraryFamilyChildren({ ...base, provider: "codex", parentId: "child" }).children), ["grandchild"]);
  assert.deepEqual(getCrossProviderSessions(base).sessions.map((item) => item.id), ["other", "root"], "legacy flat roots preserve their order and semantics");
});

test("searching a descendant retains only matching paths and never counts ancestor context as a match", () => {
  upsertIndex("codex", [row("root"), row("branch", "root"), row("leaf", "branch", { title: "Needle investigation" }),
    row("sibling", "root"), row("unmatched", "branch")]);
  const query = { ...base, search: "needle" };
  const result = queryLibraryFamilies(query);
  assert.deepEqual(ids(result.families), ["root"]);
  assert.equal(result.families[0].matched, false);
  assert.equal(result.families[0].matchingCount, 1);
  assert.equal(result.families[0].totalChildCount, 2);
  assert.equal(result.families[0].childCount, 1);
  assert.equal(result.overview.totalSessions, 1);
  assert.deepEqual(ids(queryLibraryFamilyChildren({ ...query, provider: "codex", parentId: "root" }).children), ["branch"]);
  const leaf = queryLibraryFamilyChildren({ ...query, provider: "codex", parentId: "branch" }).children;
  assert.deepEqual(ids(leaf), ["leaf"]);
  assert.equal(leaf[0].matched, true);
});

test("all filters apply to one member, including starred children, project aliases, time, and visible children", () => {
  upsertIndex("codex", [row("root", null, { title: "Needle", directory: "D:\\elsewhere" }),
    row("branch", "root", { title: "Needle", directory: "/mnt/d/project", timeUpdated: NOW }),
    row("leaf", "branch"), row("old", "root", { title: "Needle", timeUpdated: NOW - 40 * 86400000 })]);
  const query = { ...base, search: "needle", project: "d:/project", timeRange: "week", hasSubagent: true,
    included: [{ provider: "codex", id: "branch" }] };
  const result = queryLibraryFamilies(query);
  assert.deepEqual(ids(result.families), ["root"]);
  assert.equal(result.overview.totalSessions, 1);
  assert.deepEqual(ids(queryLibraryFamilyChildren({ ...query, provider: "codex", parentId: "root" }).children), ["branch"]);
  assert.equal(queryLibraryFamilies({ ...query, included: [{ provider: "codex", id: "root" }] }).total, 0, "different members cannot satisfy different filters");
  assert.equal(queryLibraryFamilies({ ...query, excluded: [{ provider: "codex", id: "leaf" }] }).total, 0, "hidden children do not satisfy has-subagent");
  assert.equal(queryLibraryFamilies({ ...base, included: [] }).total, 0);
});

test("missing and hidden parents create reachable boundaries without promoting children onto a grandparent", () => {
  upsertIndex("codex", [row("root"), row("hidden", "root"), row("grandchild", "hidden"),
    row("orphan", "missing"), row("orphan-child", "orphan")]);
  const query = { ...base, excluded: [{ provider: "codex", id: "hidden" }] };
  const result = queryLibraryFamilies(query);
  assert.deepEqual(new Set(ids(result.families)), new Set(["root", "grandchild", "orphan"]));
  const grandchild = result.families.find((node) => node.session.id === "grandchild");
  assert.equal(grandchild.parentBoundary, "hidden-parent");
  assert.equal(grandchild.session.parent_id, "hidden");
  assert.equal(result.families.find((node) => node.session.id === "orphan").parentBoundary, "missing-parent");
  assert.deepEqual(queryLibraryFamilyChildren({ ...query, provider: "codex", parentId: "root" }).children, []);
  assert.equal(queryLibraryFamilyChildren({ ...query, provider: "codex", parentId: "hidden" }).parent, null);
  assert.equal(queryLibraryFamilyChildren({ ...query, provider: "codex", parentId: "missing" }).parent, null);
  assert.equal(result.overview.totalSessions, 4);
});

test("provider identity prevents cross-provider grouping and metadata selection", () => {
  upsertIndex("codex", [row("root"), row("child", "root")]);
  upsertIndex("pi", [row("child", "root")]);
  const query = { providers: ["codex", "pi"], excluded: [{ provider: "pi", id: "root" }] };
  const result = queryLibraryFamilies(query);
  assert.equal(result.total, 2);
  assert.equal(result.families.find((node) => node.session.provider === "pi").parentBoundary, "hidden-parent");
  assert.equal(result.families.find((node) => node.session.provider === "codex").childCount, 1);
  assert.equal(queryLibraryFamilies({ ...query, included: [{ provider: "pi", id: "child" }] }).overview.totalSessions, 1);
  assert.deepEqual(queryLibraryFamilyChildren({ providers: ["pi"], provider: "codex", parentId: "root" }).children, []);
});

test("direct-child pages preserve stable identities, bounded size, filters, and exact totals", () => {
  upsertIndex("codex", [row("root"), ...Array.from({ length: 43 }, (_, index) => row(`child-${String(index).padStart(2, "0")}`, "root"))]);
  const query = { ...base, provider: "codex", parentId: "root" };
  const pages = [0, 20, 40].map((offset) => queryLibraryFamilyChildren({ ...query, offset }));
  assert.deepEqual(pages.map((page) => page.children.length), [20, 20, 3]);
  assert.deepEqual(pages.map((page) => page.hasMore), [true, true, false]);
  assert.equal(new Set(pages.flatMap((page) => ids(page.children))).size, 43);
  assert.ok(pages.every((page) => page.total === 43));
  assert.equal(queryLibraryFamilyChildren({ ...query, search: "child-4" }).total, 3);
});

test("effective titles sort and match without mutating raw records; facets share member semantics", () => {
  upsertIndex("codex", [row("zebra"), row("alpha", null, { directory: "/mnt/d/project" }),
    row("child", "zebra", { title: "Audit", directory: "D:\\second" })]);
  const query = { ...base, titleOverrides: [{ provider: "codex", id: "zebra", title: "Aardvark" }] };
  assert.deepEqual(ids(queryLibraryFamilies({ ...query, sort: "title-asc" }).families), ["zebra", "alpha"]);
  assert.deepEqual(ids(queryLibraryFamilies({ ...query, sort: "title-desc" }).families), ["alpha", "zebra"]);
  const result = queryLibraryFamilies({ ...query, search: "aardvark" });
  assert.deepEqual(ids(result.families), ["zebra"]);
  assert.equal(result.families[0].session.title, "zebra");
  const facets = queryLibraryFamilyProjects({ ...base, project: "D:\\second" });
  assert.deepEqual(facets.map((facet) => facet.count), [2, 1], "project aliases merge, selected project does not hide other facets");
  assert.equal(queryLibraryFamilyProjects({ ...base, search: "audit" })[0].count, 1);
});

test("cyclic external parent records remain independently reachable with explicit boundary evidence", () => {
  upsertIndex("codex", [row("a", "b"), row("b", "a"), row("child", "a"), row("self", "self")]);
  const result = queryLibraryFamilies(base);
  assert.deepEqual(new Set(ids(result.families)), new Set(["a", "b", "self"]));
  assert.ok(result.families.every((node) => node.parentBoundary === "cyclic-parent"));
  assert.equal(result.overview.totalSessions, 4);
  assert.deepEqual(ids(queryLibraryFamilyChildren({ ...base, provider: "codex", parentId: "a" }).children), ["child"]);
});

test("live provider snapshots completely replace indexed rows while other providers remain indexed", () => {
  upsertIndex("opencode", [row("stale"), row("root", null, { title: "Old title" })]);
  upsertIndex("codex", [row("indexed")]);
  const liveSessions = new Map([["opencode", [
    { ...row("root", null, { title: "Current title" }), provider: "opencode" },
    { ...row("child", "root"), provider: "opencode" }
  ]]]);
  const query = { providers: ["opencode", "codex"], liveSessions };
  const result = queryLibraryFamilies(query);
  assert.deepEqual(new Set(ids(result.families)), new Set(["root", "indexed"]));
  assert.equal(result.families.find((node) => node.session.id === "root").session.title, "Current title");
  assert.deepEqual(ids(queryLibraryFamilyChildren({ ...query, provider: "opencode", parentId: "root" }).children), ["child"]);
  assert.equal(queryLibraryFamilyProjects(query)[0].count, 3);
  liveSessions.set("opencode", []);
  assert.deepEqual(ids(queryLibraryFamilies(query).families), ["indexed"], "empty snapshot removes stale rows too");
  assert.deepEqual(new Set(getCrossProviderSessions({ providers: ["opencode"] }).sessions.map((session) => session.id)), new Set(["stale", "root"]), "the persistent index was not changed");
});
