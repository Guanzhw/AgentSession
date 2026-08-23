import { getDeletedIds } from "../meta.js";
import { supportsLocalManagement } from "../providers/kinds.js";
import { createSessionCatalog } from "../session-queries.js";
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
      const sessions = createSessionCatalog(adapter, providerSegment).byIds(deletedIds);
      return {
        status: 200,
        body: renderTrashPage({ sessions, ...renderContext }),
        contentType: "text/html; charset=utf-8"
      };
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      return { status: 500, body: JSON.stringify({ error: "Internal server error" }), contentType: "application/json; charset=utf-8" };
    }
  });
}
