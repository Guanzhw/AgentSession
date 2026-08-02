import { getSessionsByIds } from "../db.js";
import { getIndexedSessions } from "../index-db.js";
import { getAllMeta, getDeletedIds } from "../meta.js";
import { supportsLocalManagement, usesOpenCodeStatsStore } from "../providers/kinds.js";
import { enrichSession, normalizeSessionRecord } from "../session-queries.js";
import { renderTrashPage } from "../views/trash.js";
import { providerRenderContext } from "./provider-context.js";
import type { ProviderRouteDeps } from "./route-deps.js";

export function registerTrashRoutes(app: any, deps: ProviderRouteDeps) {
  const { providerMap, providerInfo } = deps;

  app.get("/:provider/trash", async (_req: any, _res: any, params: any) => {
    const providerSegment = params.provider;
    const adapter = providerMap.get(providerSegment);

    if (!supportsLocalManagement(adapter)) {
      return { status: 404, body: "<h1>Not found</h1>", contentType: "text/html; charset=utf-8" };
    }

    const renderContext = providerRenderContext(providerSegment, providerInfo, adapter);

    try {
      const deletedIds = getDeletedIds(providerSegment);
      const sessions = usesOpenCodeStatsStore(adapter)
        ? getSessionsByIds(deletedIds, adapter.getDataPath())
        : getIndexedSessions(providerSegment, Math.max(1, deletedIds.length), 0, "", "", "", "updated-desc", deletedIds).sessions;
      const metaMap = getAllMeta(providerSegment);
      const enriched = sessions.map((session: any) => normalizeSessionRecord(enrichSession(session, metaMap)));
      return {
        status: 200,
        body: renderTrashPage({ sessions: enriched, ...renderContext }),
        contentType: "text/html; charset=utf-8"
      };
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      return { status: 500, body: JSON.stringify({ error: "Internal server error" }), contentType: "application/json; charset=utf-8" };
    }
  });
}
