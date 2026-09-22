import type { LibrarySessionRow } from "../library-families.js";
import { escapeHtml } from "../markdown.js";
import { normalizeCrossProviderProjectPath } from "../project-filter.js";
import { resolveLibraryTitle } from "../session-title.js";

export interface LibraryDiscriminator {
  /** Shortest canonical-ID prefix that is unique within the visible collision. */
  idLabel: string;
  /** Distinguishing excerpt from provider-owned user text, when indexed evidence exists. */
  excerpt: string | null;
}

function evidence(session: LibrarySessionRow): string[] {
  if (!session.library_evidence) return [];
  const parsed: unknown = JSON.parse(session.library_evidence);
  return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
}

function distinguishingExcerpt(session: LibrarySessionRow, group: LibrarySessionRow[]): string | null {
  const title = resolveLibraryTitle(session).trim().toLocaleLowerCase();
  const peerEvidence = group.filter((peer) => peer !== session)
    .map((peer) => new Set(evidence(peer).map((value) => value.replace(/\s+/g, " ").trim())));
  const candidate = evidence(session)
    .map((value, index) => ({ text: value.replace(/\s+/g, " ").trim(), index }))
    .filter(({ text }) => text.length >= 8 && text.toLocaleLowerCase() !== title)
    .map(({ text, index }) => ({
      text,
      index,
      sharedBy: peerEvidence.filter((values) => values.has(text)).length
    }))
    .filter(({ sharedBy }) => sharedBy < peerEvidence.length)
    .sort((left, right) => left.sharedBy - right.sharedBy || left.index - right.index)[0];
  if (!candidate) return null;
  const start = Math.max(0, candidate.text.length - 160);
  return `${start ? "…" : ""}${candidate.text.slice(start)}`;
}

function collisionKey(session: LibrarySessionRow): string {
  return JSON.stringify([
    session.provider,
    resolveLibraryTitle(session).toLocaleLowerCase(),
    normalizeCrossProviderProjectPath(session.directory).toLocaleLowerCase()
  ]);
}

function idLabel(id: string, peers: string[]): string {
  for (const length of [8, 12, 16, 24, 32, id.length]) {
    const candidate = id.slice(0, Math.min(length, id.length));
    if (peers.filter((peer) => peer.slice(0, candidate.length) === candidate).length === 1) return candidate;
  }
  return id;
}

export function buildLibraryDiscriminators(sessions: LibrarySessionRow[] = []): Map<string, LibraryDiscriminator> {
  const groups = new Map<string, LibrarySessionRow[]>();
  for (const session of sessions) {
    const key = collisionKey(session);
    const group = groups.get(key) || [];
    group.push(session);
    groups.set(key, group);
  }

  const result = new Map<string, LibraryDiscriminator>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const peers = group.map((session) => session.id);
    for (const session of group) {
      result.set(libraryIdentityKey(session), {
        idLabel: idLabel(session.id, peers),
        excerpt: distinguishingExcerpt(session, group)
      });
    }
  }
  return result;
}

export function libraryDiscriminatorMarkup(session: LibrarySessionRow, discriminator: LibraryDiscriminator | null = null): string {
  if (!discriminator) return "";
  const timestamp = session.time_updated;
  const exactTime = Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC")
    : null;
  const parts = [discriminator.excerpt, exactTime, `#${discriminator.idLabel}`]
    .filter((value): value is string => Boolean(value));
  return `<p class="library-session-discriminator" data-library-discriminator="true" title="${escapeHtml(session.id)}">${escapeHtml(parts.join(" · "))}</p>`;
}

export function libraryIdentityKey(session: Pick<LibrarySessionRow, "provider" | "id">): string {
  return JSON.stringify([session.provider, session.id]);
}
