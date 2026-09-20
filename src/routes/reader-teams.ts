import { getRuntimeProtocolV3, ProtocolRuntimeError } from "../protocol-runtime.js";
import { deriveReaderTeamDetailPage, deriveReaderTeamDirectoryPage, deriveReaderTeamTaskPage, resolveReaderTeamMemberContent, resolveReaderTeamTaskContent } from "../reader-teams.js";
import { json, missingProviderResponse, safeDecodeId } from "../server-helpers.js";
import { renderReaderTeamDetail, renderReaderTeamDirectoryPage, renderReaderTeamGraph, renderReaderTeamTaskPage } from "../views/reader-teams.js";
import { renderReaderCoordinationContentPage } from "../views/reader-coordination.js";
import type { ProviderRouteDeps } from "./route-deps.js";

function routeError(res: any, error: unknown) {
  if (error instanceof ProtocolRuntimeError) {
    const status = error.code === "invalid_input" ? 400 : error.code === "protocol_invalid" ? 422 : 404;
    return json(res, { ok: false, code: error.code, error: error.message }, status);
  }
  console.error(`Reader teams route error: ${error instanceof Error ? error.message : String(error)}`);
  return json(res, { ok: false, code: "internal_error", error: "Internal server error" }, 500);
}

export function registerReaderTeamRoutes(app: any, deps: ProviderRouteDeps): void {
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/reader\/teams$/, async (req: any, res: any, match: RegExpMatchArray) => {
    const provider = match[1];
    const sessionId = safeDecodeId(match[2]);
    const adapter = deps.providerMap.get(provider);
    if (!adapter) {
      const missing = missingProviderResponse(provider);
      return json(res, missing.body, missing.status);
    }
    if (!sessionId) return json(res, { ok: false, code: "invalid_input", error: "Invalid session id" }, 400);
    try {
      const params = new URL(req.url || "/", "http://localhost").searchParams;
      const size = params.get("size");
      const page = deriveReaderTeamDirectoryPage(getRuntimeProtocolV3(adapter, sessionId), {
        provider, sessionId, query: params.get("q"), cursor: params.get("cursor"),
        size: size === null ? undefined : Number(size)
      });
      if (!page.ok) return json(res, page, page.code === "stale_cursor" ? 409 : 400);
      return json(res, {
        ...page,
        html: renderReaderTeamDirectoryPage(page),
        graphHtml: renderReaderTeamGraph(page)
      });
    } catch (error) {
      return routeError(res, error);
    }
  });

  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/reader\/team$/, async (req: any, res: any, match: RegExpMatchArray) => {
    const provider = match[1];
    const sessionId = safeDecodeId(match[2]);
    const adapter = deps.providerMap.get(provider);
    if (!adapter) {
      const missing = missingProviderResponse(provider);
      return json(res, missing.body, missing.status);
    }
    if (!sessionId) return json(res, { ok: false, code: "invalid_input", error: "Invalid session id" }, 400);
    try {
      const params = new URL(req.url || "/", "http://localhost").searchParams;
      const size = params.get("size");
      const cursor = params.get("cursor");
      const page = deriveReaderTeamDetailPage(getRuntimeProtocolV3(adapter, sessionId), {
        provider, sessionId, key: params.get("key"), cursor,
        size: size === null ? undefined : Number(size)
      });
      if (!page.ok) {
        const status = page.code === "selection_not_found" ? 404 : page.code === "stale_cursor" ? 409 : 400;
        return json(res, page, status);
      }
      return json(res, { ...page, html: renderReaderTeamDetail(page, Boolean(cursor)) });
    } catch (error) {
      return routeError(res, error);
    }
  });

  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/reader\/team\/tasks$/, async (req: any, res: any, match: RegExpMatchArray) => {
    const provider = match[1];
    const sessionId = safeDecodeId(match[2]);
    const adapter = deps.providerMap.get(provider);
    if (!adapter) {
      const missing = missingProviderResponse(provider);
      return json(res, missing.body, missing.status);
    }
    if (!sessionId) return json(res, { ok: false, code: "invalid_input", error: "Invalid session id" }, 400);
    try {
      const params = new URL(req.url || "/", "http://localhost").searchParams;
      const size = params.get("size");
      const page = deriveReaderTeamTaskPage(getRuntimeProtocolV3(adapter, sessionId), {
        provider, sessionId, key: params.get("key"), cursor: params.get("cursor"),
        size: size === null ? undefined : Number(size)
      });
      if (!page.ok) {
        const status = page.code === "selection_not_found" ? 404 : page.code === "stale_cursor" ? 409 : 400;
        return json(res, page, status);
      }
      return json(res, { ...page, html: renderReaderTeamTaskPage(page) });
    } catch (error) {
      return routeError(res, error);
    }
  });

  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/reader\/team\/task\/([^/]+)\/content$/, async (req: any, res: any, match: RegExpMatchArray) => {
    const provider = match[1];
    const sessionId = safeDecodeId(match[2]);
    const taskId = safeDecodeId(match[3]);
    const adapter = deps.providerMap.get(provider);
    if (!adapter) {
      const missing = missingProviderResponse(provider);
      return json(res, missing.body, missing.status);
    }
    if (!sessionId || !taskId) return json(res, { ok: false, code: "invalid_input", error: "Invalid task content identity" }, 400);
    try {
      const params = new URL(req.url || "/", "http://localhost").searchParams;
      const offset = Number(params.get("offset") || "0");
      if (!Number.isSafeInteger(offset) || offset < 0) {
        return json(res, { ok: false, code: "invalid_input", error: "Invalid task content offset" }, 400);
      }
      const content = resolveReaderTeamTaskContent(getRuntimeProtocolV3(adapter, sessionId), { provider, sessionId, taskId });
      if (!content.ok) {
        if (offset > 0 && content.code === "selection_not_found") {
          return json(res, { ok: false, code: "stale_content", error: "The team task description changed while it was being read." }, 409);
        }
        return json(res, content, content.code === "selection_not_found" ? 404 : 400);
      }
      const expectedRevision = params.get("revision");
      if (offset > 0 && expectedRevision !== content.revision) {
        return json(res, { ok: false, code: "stale_content", error: "The team task description changed while it was being read." }, 409);
      }
      return json(res, {
        ok: true, provider, sessionId, taskId, revision: content.revision,
        ...renderReaderCoordinationContentPage({ text: content.description, format: "markdown" }, offset)
      });
    } catch (error) {
      return routeError(res, error);
    }
  });

  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/reader\/team\/member\/([^/]+)\/content$/, async (req: any, res: any, match: RegExpMatchArray) => {
    const provider = match[1];
    const sessionId = safeDecodeId(match[2]);
    const actorId = safeDecodeId(match[3]);
    const adapter = deps.providerMap.get(provider);
    if (!adapter) {
      const missing = missingProviderResponse(provider);
      return json(res, missing.body, missing.status);
    }
    if (!sessionId || !actorId) return json(res, { ok: false, code: "invalid_input", error: "Invalid member content identity" }, 400);
    try {
      const params = new URL(req.url || "/", "http://localhost").searchParams;
      const offset = Number(params.get("offset") || "0");
      if (!Number.isSafeInteger(offset) || offset < 0) {
        return json(res, { ok: false, code: "invalid_input", error: "Invalid member content offset" }, 400);
      }
      const content = resolveReaderTeamMemberContent(getRuntimeProtocolV3(adapter, sessionId), { provider, sessionId, actorId });
      if (!content.ok) {
        if (offset > 0 && content.code === "selection_not_found") {
          return json(res, { ok: false, code: "stale_content", error: "The team member description changed while it was being read." }, 409);
        }
        return json(res, content, content.code === "selection_not_found" ? 404 : 400);
      }
      const expectedRevision = params.get("revision");
      if (offset > 0 && expectedRevision !== content.revision) {
        return json(res, { ok: false, code: "stale_content", error: "The team member description changed while it was being read." }, 409);
      }
      return json(res, {
        ok: true, provider, sessionId, actorId, revision: content.revision,
        ...renderReaderCoordinationContentPage({ text: content.description, format: "markdown" }, offset)
      });
    } catch (error) {
      return routeError(res, error);
    }
  });
}
