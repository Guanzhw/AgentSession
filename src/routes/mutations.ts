import {
  json,
  readBody,
  safeDecodeId,
  isTrustedLocalJsonRequest
} from "../server-helpers.js";
import { getConfig, applyRuntimeUserConfig, readUserConfigDocument, validateUserConfig, writeUserConfig } from "../config.js";
import { clearIndex, getIndexDb, upsertIndex } from "../index-db.js";
import {
  batchAction,
  getMeta,
  permanentDelete,
  renameSession,
  restoreSession,
  softDelete,
  toggleStar
} from "../meta.js";
import { supportsLocalManagement } from "../providers/kinds.js";
import {
  getRuntimeRouteContext,
  recordRuntimeEvent,
  runtimeErrorMessage,
  runtimeLevelForStatus
} from "../runtime-log.js";
import { getResumeCommand, launchResumeCommand } from "../resume.js";
import { runtimeExecutableName } from "../runtime-log.js";

export function registerMutations(
  app: any,
  deps: {
    appConfig: any;
    providerMap: Map<string, any>;
    availableProviders: any[];
  }
) {
  const { appConfig, providerMap, availableProviders } = deps;

  app.get("/api/settings", async (req: any, res: any, _params: any) => {
    const configDocument = readUserConfigDocument(appConfig.configPath);
    return json(res, {
      ok: true,
      configPath: appConfig.configPath,
      config: configDocument.config,
      raw: configDocument.raw,
      error: configDocument.error,
      terminalLaunchAllowed: Boolean(appConfig.allowTerminalLaunch)
    });
  });

  app.post("/api/settings", async (req: any, res: any, _params: any) => {
    if (!isTrustedLocalJsonRequest(req)) {
      return json(res, { ok: false, error: "Settings requests must be same-origin JSON from loopback" }, 403);
    }

    try {
      const body = await readBody(req);
      const nextConfig = body?.config;
      const validationErrors = validateUserConfig(nextConfig);
      if (validationErrors.length) {
        return json(res, {
          ok: false,
          error: "Invalid configuration",
          validationErrors
        }, 400);
      }

      const previousDocument = readUserConfigDocument(appConfig.configPath);
      const restartRequiredKeys = getRestartRequiredKeys(previousDocument.config, nextConfig);
      writeUserConfig(appConfig.configPath, nextConfig);
      applyRuntimeUserConfig(appConfig, nextConfig);
      recordRuntimeEvent(appConfig.metaDir, {
        event: "settings.save",
        level: "info",
        changedKeys: Object.keys(nextConfig || {}).sort(),
        restartRequiredKeys,
        ignoredKeys: Object.prototype.hasOwnProperty.call(nextConfig, "allowTerminalLaunch")
          ? ["allowTerminalLaunch"]
          : []
      });
      return json(res, {
        ok: true,
        configPath: appConfig.configPath,
        restartRequiredKeys,
        terminalLaunchAllowed: Boolean(appConfig.allowTerminalLaunch),
        ignoredKeys: Object.prototype.hasOwnProperty.call(nextConfig, "allowTerminalLaunch")
          ? ["allowTerminalLaunch"]
          : []
      });
    } catch (error: any) {
      console.error("Settings save error:", error?.message || error);
      recordRuntimeEvent(appConfig.metaDir, {
        event: "settings.save",
        level: "error",
        ok: false,
        error: runtimeErrorMessage(error)
      });
      return json(res, {
        ok: false,
        error: error?.message || "Failed to save settings",
        validationErrors: error?.validationErrors || []
      }, 500);
    }
  });

  // Session mutations (star/rename/delete/restore/permanent-delete)
  app.post(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/(star|rename|delete|restore|permanent-delete)$/, async (req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const adapter = providerMap.get(providerId);
    if (!supportsLocalManagement(adapter)) {
      return json(res, { ok: false, error: "Not supported for this provider" }, 501);
    }

    const rawId = match[2];
    const id = safeDecodeId(rawId);
    if (!id) return json(res, { ok: false, error: "Invalid session ID" }, 400);
    const action = match[3];
    const existingMeta = getMeta(providerId, id);
    const canManageMissingSource = (action === "restore" || action === "permanent-delete")
      && Boolean(existingMeta?.deleted);
    if (adapter && !adapter.getSession(id) && !canManageMissingSource) {
      return json(res, { ok: false, error: "Session not found" }, 404);
    }
    try {
      if (action === "star") {
        const starred = toggleStar(providerId, id);
        recordRuntimeEvent(appConfig.metaDir, {
          event: "session.meta.update",
          provider: providerId,
          sessionId: id,
          action,
          starred,
          ok: true
        });
        return json(res, { ok: true, starred });
      }
      if (action === "rename") {
        const body = await readBody(req);
        renameSession(providerId, id, body.title || "");
        recordRuntimeEvent(appConfig.metaDir, {
          event: "session.meta.update",
          provider: providerId,
          sessionId: id,
          action,
          ok: true
        });
        return json(res, { ok: true });
      }
      if (action === "delete") {
        softDelete(providerId, id);
        recordRuntimeEvent(appConfig.metaDir, {
          event: "session.meta.update",
          provider: providerId,
          sessionId: id,
          action,
          ok: true
        });
        return json(res, { ok: true });
      }
      if (action === "restore") {
        restoreSession(providerId, id);
        recordRuntimeEvent(appConfig.metaDir, {
          event: "session.meta.update",
          provider: providerId,
          sessionId: id,
          action,
          ok: true
        });
        return json(res, { ok: true });
      }
      if (action === "permanent-delete") {
        permanentDelete(providerId, id);
        recordRuntimeEvent(appConfig.metaDir, {
          event: "session.meta.update",
          provider: providerId,
          sessionId: id,
          action,
          ok: true
        });
        return json(res, { ok: true });
      }
    } catch (error: any) {
      console.error("Mutation error:", error?.message || error);
      recordRuntimeEvent(appConfig.metaDir, {
        event: "session.meta.update",
        level: "error",
        provider: providerId,
        sessionId: id,
        action,
        ok: false,
        error: runtimeErrorMessage(error)
      });
      return json(res, { ok: false, error: "Internal server error" }, 500);
    }
  });

  // Legacy mutation route (without provider prefix)
  app.post(/^\/api\/session\/([^/]+)\/(star|rename|delete|restore|permanent-delete)$/, async (req: any, res: any, match: RegExpMatchArray) => {
    const providerId = "opencode";
    const adapter = providerMap.get(providerId);
    if (!supportsLocalManagement(adapter)) {
      return json(res, { ok: false, error: "Not supported for this provider" }, 501);
    }

    const rawId = match[1];
    const id = safeDecodeId(rawId);
    if (!id) return json(res, { ok: false, error: "Invalid session ID" }, 400);
    const action = match[2];
    const existingMeta = getMeta(providerId, id);
    const canManageMissingSource = (action === "restore" || action === "permanent-delete")
      && Boolean(existingMeta?.deleted);
    if (adapter && !adapter.getSession(id) && !canManageMissingSource) {
      return json(res, { ok: false, error: "Session not found" }, 404);
    }
    try {
      if (action === "star") {
        const starred = toggleStar(providerId, id);
        recordRuntimeEvent(appConfig.metaDir, {
          event: "session.meta.update",
          provider: providerId,
          sessionId: id,
          action,
          starred,
          ok: true
        });
        return json(res, { ok: true, starred });
      }
      if (action === "rename") {
        const body = await readBody(req);
        renameSession(providerId, id, body.title || "");
        recordRuntimeEvent(appConfig.metaDir, {
          event: "session.meta.update",
          provider: providerId,
          sessionId: id,
          action,
          ok: true
        });
        return json(res, { ok: true });
      }
      if (action === "delete") {
        softDelete(providerId, id);
        recordRuntimeEvent(appConfig.metaDir, {
          event: "session.meta.update",
          provider: providerId,
          sessionId: id,
          action,
          ok: true
        });
        return json(res, { ok: true });
      }
      if (action === "restore") {
        restoreSession(providerId, id);
        recordRuntimeEvent(appConfig.metaDir, {
          event: "session.meta.update",
          provider: providerId,
          sessionId: id,
          action,
          ok: true
        });
        return json(res, { ok: true });
      }
      if (action === "permanent-delete") {
        permanentDelete(providerId, id);
        recordRuntimeEvent(appConfig.metaDir, {
          event: "session.meta.update",
          provider: providerId,
          sessionId: id,
          action,
          ok: true
        });
        return json(res, { ok: true });
      }
    } catch (error: any) {
      console.error("Mutation error:", error?.message || error);
      recordRuntimeEvent(appConfig.metaDir, {
        event: "session.meta.update",
        level: "error",
        provider: providerId,
        sessionId: id,
        action,
        ok: false,
        error: runtimeErrorMessage(error)
      });
      return json(res, { ok: false, error: "Internal server error" }, 500);
    }
  });

  // Batch actions
  app.post("/api/batch", async (req: any, res: any, _match: any) => {
    const providerId = "opencode";
    const adapter = providerMap.get(providerId);
    if (!supportsLocalManagement(adapter)) {
      return json(res, { ok: false, error: "Not supported for this provider" }, 501);
    }

    try {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const validActions = ["delete", "star", "unstar", "restore", "permanent-delete"];
      if (!validActions.includes(body.action)) {
        return json(res, { ok: false, error: "Invalid action" }, 400);
      }
      const affected = batchAction(providerId, ids, body.action);
      recordRuntimeEvent(appConfig.metaDir, {
        event: "session.meta.batch",
        provider: providerId,
        action: body.action,
        requestedCount: ids.length,
        affected,
        ok: true
      });
      return json(res, { ok: true, affected });
    } catch (error: any) {
      console.error("Mutation error:", error?.message || error);
      recordRuntimeEvent(appConfig.metaDir, {
        event: "session.meta.batch",
        level: "error",
        provider: providerId,
        ok: false,
        error: runtimeErrorMessage(error)
      });
      return json(res, { ok: false, error: "Internal server error" }, 500);
    }
  });

  // Prefixed batch
  app.post(/^\/api\/([a-z][a-z0-9-]*)\/batch$/, async (req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const adapter = providerMap.get(providerId);
    if (!supportsLocalManagement(adapter)) {
      return json(res, { ok: false, error: "Not supported for this provider" }, 501);
    }

    try {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const validActions = ["delete", "star", "unstar", "restore", "permanent-delete"];
      if (!validActions.includes(body.action)) {
        return json(res, { ok: false, error: "Invalid action" }, 400);
      }
      const affected = batchAction(providerId, ids, body.action);
      recordRuntimeEvent(appConfig.metaDir, {
        event: "session.meta.batch",
        provider: providerId,
        action: body.action,
        requestedCount: ids.length,
        affected,
        ok: true
      });
      return json(res, { ok: true, affected });
    } catch (error: any) {
      console.error("Mutation error:", error?.message || error);
      recordRuntimeEvent(appConfig.metaDir, {
        event: "session.meta.batch",
        level: "error",
        provider: providerId,
        ok: false,
        error: runtimeErrorMessage(error)
      });
      return json(res, { ok: false, error: "Internal server error" }, 500);
    }
  });

  // Reindex
  app.post("/api/reindex", async (_req: any, res: any, _match: any) => {
    try {
      getIndexDb();
      const results: any[] = [];
      recordRuntimeEvent(appConfig.metaDir, {
        event: "provider.reindex.start",
        providerCount: availableProviders.length
      });
      for (const provider of availableProviders) {
        const startTime = Date.now();
        const sessions: any[] = [];
        for await (const session of provider.scan()) {
          sessions.push(session);
        }
        clearIndex(provider.id);
        upsertIndex(provider.id, sessions);
        results.push({ provider: provider.id, indexed: sessions.length, tookMs: Date.now() - startTime });
      }
      recordRuntimeEvent(appConfig.metaDir, {
        event: "provider.reindex.complete",
        providerCount: results.length,
        results,
        ok: true
      });
      return json(res, { ok: true, results });
    } catch (error: any) {
      console.error("Mutation error:", error?.message || error);
      recordRuntimeEvent(appConfig.metaDir, {
        event: "provider.reindex.failed",
        level: "error",
        ok: false,
        error: runtimeErrorMessage(error)
      });
      return json(res, { ok: false, error: "Internal server error" }, 500);
    }
  });

  // Resume
  app.post(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/resume$/, async (req: any, res: any, match: RegExpMatchArray) => {
    if (!isTrustedLocalJsonRequest(req)) {
      return json(res, { ok: false, error: "Resume requests must be same-origin JSON from loopback" }, 403);
    }
    if (!appConfig.allowTerminalLaunch) {
      return json(res, { ok: false, error: "Terminal launch is disabled" }, 403);
    }

    const providerId = match[1];
    const sessionId = safeDecodeId(match[2]);
    const adapter = providerMap.get(providerId);
    if (!sessionId || !adapter) {
      return json(res, { ok: false, error: "Session not found" }, 404);
    }
    const session = adapter.getSession(sessionId);
    if (!session) {
      return json(res, { ok: false, error: "Session not found" }, 404);
    }

    try {
      const session = adapter.getSession(sessionId);
      if (!session) {
        return json(res, { ok: false, error: "Session not found" }, 404);
      }
      const command = getResumeCommand(
        adapter,
        sessionId,
        session.directory,
        appConfig.resumeCommands
      );
      if (!command) {
        return json(res, { ok: false, error: "No valid project directory or resume command" }, 400);
      }
      if (!command.available) {
        return json(res, { ok: false, error: "Configured resume executable was not found" }, 409);
      }
      const launchResult = await launchResumeCommand(command, appConfig.resumeShell);
      recordRuntimeEvent(appConfig.metaDir, {
        event: "terminal.resume.launch",
        provider: providerId,
        sessionId,
        executable: runtimeExecutableName(command),
        cwd: command.cwd,
        launchPid: launchResult?.pid ?? null,
        launchHost: launchResult?.usedTerminal ? "terminal" : "powershell",
        fallbackFrom: (launchResult as any)?.fallbackFrom,
        ok: true
      });
      return json(res, { ok: true });
    } catch (error: any) {
      console.error("Resume launch error:", error?.message || error);
      recordRuntimeEvent(appConfig.metaDir, {
        event: "terminal.resume.launch",
        level: "error",
        provider: providerId,
        sessionId,
        ok: false,
        error: runtimeErrorMessage(error)
      });
      return json(res, { ok: false, error: error?.message || "Failed to launch terminal" }, 500);
    }
  });
}

function getRestartRequiredKeys(previousConfig: any, nextConfig: any): string[] {
  const runtimeKeys = new Set(["analysis", "resumeCommands", "resumeShell", "allowTerminalLaunch"]);
  const keys = new Set([
    ...Object.keys(previousConfig || {}),
    ...Object.keys(nextConfig || {})
  ]);
  return [...keys]
    .filter((key) => !runtimeKeys.has(key))
    .filter((key) => JSON.stringify(previousConfig?.[key]) !== JSON.stringify(nextConfig?.[key]))
    .sort();
}
