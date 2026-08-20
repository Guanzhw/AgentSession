import { readUserConfigDocument } from "../config.js";
import { getProvider } from "../providers/index.js";
import { renderSettingsPage } from "../views/settings.js";
import { providerRenderContext } from "./provider-context.js";
import type { ProviderRouteDeps } from "./route-deps.js";

export function registerSettingsRoutes(app: any, deps: ProviderRouteDeps) {
  const { appConfig, providerMap, providerInfo } = deps;

  app.get("/:provider/settings", async (_req: any, _res: any, params: any) => {
    const providerSegment = params.provider;
    const currentProvider = getProvider(providerSegment);
    const adapter = providerMap.get(providerSegment);

    if (!currentProvider) {
      return { status: 404, body: "<h1>Provider not found</h1>", contentType: "text/html; charset=utf-8" };
    }

    const configDocument = readUserConfigDocument(appConfig.configPath);
    return {
      status: 200,
      body: renderSettingsPage({
        configPath: appConfig.configPath,
        configDocument,
        terminalLaunchAllowed: Boolean(appConfig.allowTerminalLaunch),
        providerName: currentProvider.name,
        resumeDefault: currentProvider.resumeCommand || null,
        providerAvailable: Boolean(adapter),
        ...providerRenderContext(providerSegment, providerInfo, adapter)
      }),
      contentType: "text/html; charset=utf-8"
    };
  });
}
