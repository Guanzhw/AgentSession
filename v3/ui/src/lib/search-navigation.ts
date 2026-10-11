import type { GlobalSearchTarget, SearchMatch, SessionRef } from './api';

export function searchMatchHref(match: SearchMatch): string {
  const path = '/' + encodeURIComponent(match.session.provider) + '/session/' + encodeURIComponent(match.session.sessionId);
  if (!match.event) return path;
  const query = new URLSearchParams({ messageId: match.event.messageId, segment: match.event.segment });
  if (match.target) {
    query.set('field', match.target.field);
    query.set('offset', String(match.target.offset));
    query.set('matchLength', String(match.target.matchLength));
    query.set('contentRevision', match.target.contentRevision);
  }
  return path + '#event?' + query;
}

/** Validate the URL boundary once; ordinary event links contain no content target. */
export function searchTargetFromHash(hash: string, session: SessionRef): GlobalSearchTarget | null {
  if (!hash.startsWith('#event?')) return null;
  const query = new URLSearchParams(hash.slice(7));
  if (!['field', 'offset', 'matchLength', 'contentRevision'].some(key => query.has(key))) return null;
  const messageId = query.get('messageId');
  const segment = query.get('segment');
  const field = query.get('field');
  const offset = Number(query.get('offset'));
  const matchLength = Number(query.get('matchLength'));
  const contentRevision = query.get('contentRevision');
  if (!messageId || segment !== 'message' || field !== 'body'
    || !query.has('offset') || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(matchLength) || matchLength < 1 || matchLength > 1000
    || !contentRevision || !/^[a-f0-9]{64}$/.test(contentRevision)) {
    throw new Error('The search destination is invalid. Return to Library and search again.');
  }
  return { event: { ...session, messageId, segment }, field, offset, matchLength, contentRevision };
}
