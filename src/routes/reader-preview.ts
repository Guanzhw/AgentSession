import { getSessionDocument } from "../session-queries.js";
import { json, missingProviderResponse, safeDecodeId } from "../server-helpers.js";
import { buildReaderPreview, renderReaderPreviewHtml } from "../reader-preview.js";
import type { ProviderRouteDeps } from "./route-deps.js";

/** Register the bounded, on-demand selected-child Reader preview. */
export function registerReaderPreviewRoutes(app: any, deps: ProviderRouteDeps): void {
  const { providerMap } = deps;
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/reader\/preview$/, async (_req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const sessionId = safeDecodeId(match[2]);
    const adapter = providerMap.get(providerId);
    if (!adapter) {
      const missing = missingProviderResponse(providerId);
      return json(res, missing.body, missing.status);
    }
    if (!sessionId) {
      return json(res, { ok: false, error: "Invalid reader preview reference", code: "invalid_input" }, 400);
    }
    try {
      // This route is intentionally a single selected-session read. Parent
      // relationship evidence belongs to the owning reader projection.
      const document = getSessionDocument(adapter, providerId, sessionId);
      if (!document) {
        return json(res, { ok: false, error: "Reader child not found", code: "child_not_found" }, 404);
      }
      const preview = buildReaderPreview(document, providerId, sessionId);
      return json(res, {
        ok: true,
        provider: providerId,
        sessionId,
        request: preview.request,
        reply: preview.reply,
        html: renderReaderPreviewHtml(preview)
      });
    } catch (error: any) {
      console.error(`Reader preview route error: ${error?.message || String(error)}`);
      return json(res, { ok: false, error: "Reader child unavailable", code: "child_unavailable" }, 422);
    }
  });
}
