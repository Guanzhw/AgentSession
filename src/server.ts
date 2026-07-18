import { createServer } from "node:http";

import {
  applyRuntimeUserConfig,
  getConfig
} from "./config.js";
import { getStats } from "./db.js";
import { getLocale, setLocale } from "./i18n.js";
import { getIndexDb, indexProvider } from "./index-db.js";
import { getAllProviders, getAvailableProviders } from "./providers/index.js";
import { supportsLocalManagement, usesSqliteSessionStore } from "./providers/kinds.js";
import {
  getRuntimeRouteContext,
  recordRuntimeEvent,
  runtimeErrorMessage,
  runtimeLevelForStatus
} from "./runtime-log.js";
import {
  json,
  send,
  serveStatic
} from "./server-helpers.js";
import { Router } from "./router.js";

// Re-export session query functions for test compatibility
export {
  resolveSessionSort,
  resolveStarredFilter,
  resolveSessionSearchMode,
  resolveSessionKindFilter,
  getVisibleListResults,
  getIndexedListResults,
  getSearchResults
} from "./session-queries.js";

import { registerMutations } from "./routes/mutations.js";
import { registerAnalysisRoutes } from "./routes/analysis-routes.js";
import { registerSessions } from "./routes/sessions.js";
import { registerSessionDetail } from "./routes/session-detail.js";
import { registerSettingsStatsTrash } from "./routes/settings-stats-trash.js";

// ── Build router with current state ─────────────────────────────────────────

function buildRouter(
  appConfig: any,
  providerMap: Map<string, any>,
  providerInfo: any[],
  availableProviders: any[]
): Router {
  const router = new Router();
  registerMutations(router, { appConfig, providerMap, availableProviders });
  registerAnalysisRoutes(router, { appConfig, providerMap });
  // Register static global explorer entries before the single-segment
  // provider route (`/:provider`) so `/stats` cannot be mistaken for a provider.
  registerSettingsStatsTrash(router, { appConfig, providerMap, providerInfo });
  registerSessions(router, { appConfig, providerMap, providerInfo });
  registerSessionDetail(router, { appConfig, providerMap, providerInfo });
  return router;
}

// ── startServer ─────────────────────────────────────────────────────────────

export async function startServer(config = getConfig()) {
  const appConfig = config ?? getConfig();
  setLocale(appConfig.lang);
  const PORT = appConfig.port;

  try {
    recordRuntimeEvent(appConfig.metaDir, {
      event: "server.start",
      port: PORT,
      lang: appConfig.lang,
      terminalLaunchAllowed: Boolean(appConfig.allowTerminalLaunch)
    });

    // Index all providers
    const providers = getAvailableProviders();
    getIndexDb();
    for (const provider of providers) {
      try {
        const startTime = Date.now();
        recordRuntimeEvent(appConfig.metaDir, {
          event: "provider.index.start",
          provider: provider.id
        });
        const indexed = await indexProvider(provider);
        const durationMs = Date.now() - startTime;
        recordRuntimeEvent(appConfig.metaDir, {
          event: "provider.index.complete",
          provider: provider.id,
          indexed,
          durationMs,
          ok: true
        });
        console.log(`Indexed ${indexed} sessions for ${provider.id} in ${durationMs}ms`);
      } catch (err: any) {
        console.error(`Failed to index ${provider.id}: ${err.message}`);
        recordRuntimeEvent(appConfig.metaDir, {
          event: "provider.index.failed",
          level: "error",
          provider: provider.id,
          ok: false,
          error: runtimeErrorMessage(err)
        });
      }
    }

    // Cache provider data after indexing
    const availableProviders = providers;
    const providerMap = new Map(availableProviders.map((provider) => [provider.id, provider]));
    const availableIds = new Set(availableProviders.map((p) => p.id));
    const providerInfo = getAllProviders().map((p) => ({
      id: p.id,
      name: p.name,
      icon: p.icon,
      available: availableIds.has(p.id),
      manageable: supportsLocalManagement(p)
    }));

    // Build router with populated deps
    const router = buildRouter(appConfig, providerMap, providerInfo, availableProviders);

    // Startup stats
    const statsProvider = availableProviders.find((provider) => provider.id === "opencode")
      || availableProviders.find((provider) => usesSqliteSessionStore(provider));
    const stats = statsProvider ? getStats(statsProvider.getDataPath() || undefined) : { totalSessions: 0, totalMessages: 0 };

    const requestHandler = async (req: any, res: any) => {
      const url = new URL(req.url || "/", `http://localhost:${PORT}`);
      const pathname = url.pathname;
      const requestStart = Date.now();
      const requestContext = getRuntimeRouteContext(req.method || "GET", pathname);

      if (requestContext) {
        res.once("finish", () => {
          recordRuntimeEvent(appConfig.metaDir, {
            event: "http.request",
            level: runtimeLevelForStatus(res.statusCode),
            ...requestContext,
            status: res.statusCode,
            durationMs: Date.now() - requestStart,
            ok: res.statusCode < 400
          });
        });
      }

      try {
        // Root redirect
        if (pathname === "/") {
          if (availableProviders.length > 0) {
            res.writeHead(302, { Location: "/sessions" });
            res.end();
            return;
          }
          send(res, 500, "<h1>No providers detected</h1>");
          return;
        }

        if (pathname === "/favicon.ico") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (pathname.startsWith("/static/")) {
          serveStatic(pathname, res);
          return;
        }

        // API: providers (inline - doesn't depend on route modules)
        if (req.method === "GET" && pathname === "/api/providers") {
          return json(res, providerInfo);
        }

        // Delegate to route modules
        const handled = await router.dispatch(req, res, url);
        if (handled) return;

        // 405 for unsupported methods (only GET allowed for remaining routes)
        if (req.method !== "GET") {
          send(res, 405, "Method not allowed", "text/plain; charset=utf-8");
          return;
        }

        // 404 fallback
        send(res, 404, "<h1>Not found</h1>");
      } catch (error: any) {
        console.error("Unhandled request error:", error);
        recordRuntimeEvent(appConfig.metaDir, {
          event: "http.request.failed",
          level: "error",
          ...(requestContext || { method: req.method || "GET", route: "/unmatched" }),
          status: 500,
          durationMs: Date.now() - requestStart,
          ok: false,
          error: runtimeErrorMessage(error)
        });
        if (!res.headersSent) {
          send(res, 500, "Internal server error", "text/plain; charset=utf-8");
        } else if (!res.writableEnded) {
          res.destroy(error);
        }
      }
    };

    const server = createServer(requestHandler);
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`AgentSession running at http://localhost:${PORT}`);
      console.log(`Language: ${getLocale()}`);
      console.log(`${stats.totalSessions} sessions, ${stats.totalMessages} messages.`);
      recordRuntimeEvent(appConfig.metaDir, {
        event: "server.ready",
        port: PORT,
        providerCount: availableProviders.length,
        totalSessions: stats.totalSessions,
        totalMessages: stats.totalMessages,
        ok: true
      });
    });

    if (appConfig.open) {
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      import("node:child_process").then((cp) => cp.exec(`${cmd} http://localhost:${PORT}`));
    }
  } catch (error: any) {
    console.error("Failed to start:", error.message);
    recordRuntimeEvent(appConfig.metaDir, {
      event: "server.start.failed",
      level: "error",
      port: PORT,
      ok: false,
      error: runtimeErrorMessage(error)
    });
    process.exit(1);
  }
}
