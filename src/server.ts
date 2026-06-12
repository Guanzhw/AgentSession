import { createServer } from "node:http";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyRuntimeUserConfig,
  getConfig,
  readUserConfigDocument,
  validateUserConfig,
  writeUserConfig
} from "./config.js";
import {
  getMessages,
  getParts,
  getSession,
  getStats,
  getTodos,
  listSessions,
  searchMessages,
  getTokenStats,
  getModelDistribution,
  getDailySessionCounts,
  getSessionsByIds,
  listSessionProjects
} from "./db.js";
import {
  supportsLocalManagement,
  supportsStructuredSessionViews,
  usesSqliteSessionStore
} from "./providers/kinds.js";
import { getAvailableProviders, getAllProviders, getProvider } from "./providers/index.js";
import { getIndexDb, upsertIndex, getIndexedSessions, getIndexedSessionProjects, clearIndex } from "./index-db.js";
import { setLocale, getLocale } from "./i18n.js";
import {
  toggleStar,
  renameSession,
  softDelete,
  restoreSession,
  permanentDelete,
  batchAction,
  getMeta,
  getDeletedIds,
  getAllMeta,
  getExcludedIds
} from "./meta.js";
import { renderSessionPage } from "./views/session.js";
import { renderSessionsPage } from "./views/sessions.js";
import { renderStatsPage } from "./views/stats.js";
import { renderTrashPage } from "./views/trash.js";
import { renderSettingsPage } from "./views/settings.js";
import { getResumeCommand, launchResumeCommand } from "./resume.js";
import {
  buildAnalysisPromptPreview,
  getDefaultAnalysisTargetIds,
  getSessionAnalysisAction,
  listSessionAnalysisRuns,
  launchSessionAnalysis,
  prepareSessionAnalysis
} from "./analysis.js";

const staticDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "static");

let availableProviders = [];
let providerMap = new Map();
let providerInfo = [];

function injectLocaleScript(body, contentType) {
  if (typeof body !== "string" || !contentType.startsWith("text/html")) {
    return body;
  }

  const localeScript = `<script>window.__LOCALE__=${JSON.stringify(getLocale())}</script>`;
  return body.includes("</head>")
    ? body.replace("</head>", `  ${localeScript}\n</head>`)
    : body;
}

function send(res, status, body, contentType = "text/html; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(injectLocaleScript(body, contentType));
}

function readBody(req, maxBytes = 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        resolve({});
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function safeDecodeId(encoded) {
  try {
    const decoded = decodeURIComponent(encoded);
    if (decoded.length > 500) return null;
    return decoded;
  } catch {
    return null;
  }
}

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function isTrustedLocalJsonRequest(req) {
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    return false;
  }

  const host = String(req.headers.host || "").replace(/:\d+$/, "");
  if (!isLoopbackHostname(host)) {
    return false;
  }

  const remote = req.socket?.remoteAddress || "";
  if (remote && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
    return false;
  }

  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }

  try {
    return isLoopbackHostname(new URL(String(origin)).hostname);
  } catch {
    return false;
  }
}

function getRestartRequiredKeys(previousConfig, nextConfig) {
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

function missingProviderResponse(providerId) {
  const provider = getProvider(providerId);
  if (provider) {
    return {
      status: 503,
      body: {
        ok: false,
        error: "Provider not detected",
        provider: provider.id,
        name: provider.name,
        dataPath: provider.getDataPath()
      }
    };
  }

  return {
    status: 404,
    body: { ok: false, error: "Provider not found" }
  };
}

function safeJsonParse(value) {
  if (typeof value !== "string") {
    return value || {};
  }

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function enrichSession(session, metaMap) {
  if (!session) {
    return session;
  }

  const meta = metaMap.get(session.id);
  return {
    ...session,
    starred: Boolean(meta?.starred),
    title: meta?.custom_title || session.title
  };
}

function enrichSessionList(sessions, metaMap, excludedIds) {
  return sessions
    .filter((session) => !excludedIds.has(session.id))
    .map((session) => enrichSession(session, metaMap));
}

function getSearchResults(query, limit, offset, dbPath = undefined) {
  const term = (query || "").trim();
  if (!term) {
    return { sessions: [], total: 0, note: "Enter a search query to find sessions." };
  }

  const titleMatches = listSessions(1000, 0, term, "", dbPath).sessions;
  const contentMatches = searchMessages(term, 500, dbPath);
  const orderedIds = [];
  const sessionMap = new Map();

  for (const session of titleMatches) {
    if (!sessionMap.has(session.id)) {
      orderedIds.push(session.id);
      sessionMap.set(session.id, session);
    }
  }

  for (const match of contentMatches) {
    if (!sessionMap.has(match.sessionId)) {
      const session = getSession(match.sessionId, dbPath);
      if (session) {
        orderedIds.push(session.id);
        sessionMap.set(session.id, session);
      }
    }
  }

  return {
    sessions: orderedIds.slice(offset, offset + limit).map((id) => sessionMap.get(id)).filter(Boolean),
    total: orderedIds.length,
    note: `Showing title and message-content matches for “${term}”.`
  };
}

function loadPartsByMessage(messages, dbPath = undefined) {
  const map = new Map();
  for (const message of messages) {
    map.set(
      message.id,
      getParts(message.id, dbPath).map((part) => ({
        ...part,
        data: safeJsonParse(part.data)
      }))
    );
  }
  return map;
}

function normalizeSessionRecord(session) {
  if (!session) {
    return null;
  }

  return {
    ...session,
    id: session.id,
    title: session.title || session.slug || session.id,
    directory: session.directory || "",
    time_created: Number(session.time_created ?? session.timeCreated) || 0,
    time_updated: Number(session.time_updated ?? session.timeUpdated) || 0,
    summary_files: Number(session.summary_files) || 0,
    summary_additions: Number(session.summary_additions) || 0,
    summary_deletions: Number(session.summary_deletions) || 0,
    starred: Boolean(session.starred)
  };
}

function buildPartsFromProviderMessages(providerMessages = []) {
  const messages = [];
  const partsByMessage = new Map();

  for (let i = 0; i < providerMessages.length; i += 1) {
    const source = providerMessages[i] || {};
    const messageId = source.id || `${source.sessionId || "session"}:msg:${i}`;
    messages.push({
      id: messageId,
      data: {
        role: source.role || "assistant",
        time: { created: Number(source.timestamp) || 0 },
        tokens: source.tokens || null,
        model: source.metadata?.model || null
      }
    });

    const isTool = source.role === "tool" || source.toolName;
    const contentPart = isTool
      ? {
        type: "tool",
        tool: source.toolName || "tool",
        state: {
          input: source.toolInput || null,
          output: source.toolOutput ?? source.content ?? "",
          status: "completed"
        }
      }
      : {
        type: "text",
        text: source.content || ""
      };

    const parts = [];
    if (source.thinking) {
      parts.push({
        id: `${messageId}:reasoning`,
        data: { type: "reasoning", text: source.thinking }
      });
    }
    parts.push({ id: `${messageId}:part`, data: contentPart });
    partsByMessage.set(messageId, parts);
  }

  return { messages, partsByMessage };
}

function getProviderSearchResults(adapter, query, limit, offset) {
  const term = (query || "").trim();
  if (!term) {
    return { sessions: [], total: 0, note: "Enter a search query to find sessions." };
  }

  const matches = adapter.searchMessages(term, 500);
  const orderedIds = [];
  const sessionMap = new Map();

  for (const match of matches) {
    if (sessionMap.has(match.sessionId)) {
      continue;
    }
    const session = adapter.getSession(match.sessionId);
    if (!session) {
      continue;
    }
    orderedIds.push(match.sessionId);
    sessionMap.set(match.sessionId, normalizeSessionRecord(session));
  }

  return {
    sessions: orderedIds.slice(offset, offset + limit).map((id) => sessionMap.get(id)).filter(Boolean),
    total: orderedIds.length,
    note: `Showing message-content matches for “${term}”.`
  };
}

function toApiSessionShape(session) {
  return {
    id: session.id,
    title: session.title || session.slug || session.id,
    directory: session.directory || "",
    time_updated: Number(session.time_updated) || 0,
    summary_files: Number(session.summary_files) || 0,
    summary_additions: Number(session.summary_additions) || 0,
    summary_deletions: Number(session.summary_deletions) || 0,
    starred: Boolean(session.starred)
  };
}

function completeTokenStats(rows, days = 30) {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const completed = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getTime() - offset * 86400000);
    const day = date.toISOString().slice(0, 10);
    completed.push(byDay.get(day) || {
      day,
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 0,
      message_count: 0
    });
  }

  return completed;
}

function serveStatic(reqPath, res) {
  const relativePath = reqPath.replace(/^\/static\//, "");
  const filePath = path.join(staticDir, relativePath);
  const contentType = filePath.endsWith(".css")
    ? "text/css; charset=utf-8"
    : filePath.endsWith(".js")
      ? "application/javascript; charset=utf-8"
      : "application/octet-stream";

  try {
    const body = readFileSync(filePath);
    send(res, 200, body, contentType);
  } catch {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
  }
}

function renderMarkdownExport(session, messages, partsByMessage) {
  const title = session.title || session.slug || session.id;
  const lines = [
    `# ${title}`,
    "",
    `Created: ${new Date(Number(session.time_created) || Date.now()).toLocaleString()}`,
    `Updated: ${new Date(Number(session.time_updated) || Date.now()).toLocaleString()}`,
    "",
    "---",
    ""
  ];

  for (const msg of messages) {
    const role = msg.data?.role || "unknown";
    const parts = partsByMessage.get(msg.id) || [];
    for (const part of parts) {
      const partData = part.data;
      if (partData?.type === "text" && partData.text) {
        lines.push(`## ${role}`, "", partData.text, "");
      } else if (partData?.type === "reasoning" && partData.text) {
        lines.push(`### Reasoning`, "", partData.text, "");
      } else if (partData?.type === "tool") {
        lines.push(`### Tool Call: ${partData.tool || "unknown"}`, "");
        if (partData.state?.input) {
          lines.push(
            "Input:",
            "```",
            typeof partData.state.input === "string" ? partData.state.input : JSON.stringify(partData.state.input, null, 2),
            "```",
            ""
          );
        }
        if (partData.state?.output) {
          lines.push(
            "Output:",
            "```",
            typeof partData.state.output === "string" ? partData.state.output : JSON.stringify(partData.state.output, null, 2),
            "```",
            ""
          );
        }
      }
    }
  }

  return lines.join("\n");
}

export async function startServer(config = getConfig()) {
  const appConfig = config ?? getConfig();
  setLocale(appConfig.lang);
  const PORT = appConfig.port;

  const requestHandler = async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    const pathname = url.pathname;
    const limit = 30;
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);

    // Extract provider from URL: /:provider/...
    const providerMatch = pathname.match(/^\/([a-z][a-z0-9-]*)(?:\/(.*))?$/);
    const providerSegment = providerMatch?.[1];
    const subPath = providerMatch?.[2] ? `/${providerMatch[2]}` : "/";

    // Root redirect
    if (pathname === "/") {
      const defaultProvider = availableProviders[0];
      if (defaultProvider) {
        res.writeHead(302, { Location: `/${defaultProvider.id}` });
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

    if (req.method === "GET" && pathname === "/api/providers") {
      return json(res, providerInfo);
    }

    if (req.method === "GET" && pathname === "/api/settings") {
      const configDocument = readUserConfigDocument(appConfig.configPath);
      return json(res, {
        ok: true,
        configPath: appConfig.configPath,
        config: configDocument.config,
        raw: configDocument.raw,
        error: configDocument.error,
        terminalLaunchAllowed: Boolean(appConfig.allowTerminalLaunch)
      });
    }

    const promptPreviewMatch = pathname.match(/^\/api\/([a-z][a-z0-9-]*)\/analysis\/prompt-preview$/);
    if ((req.method === "GET" || req.method === "POST") && promptPreviewMatch) {
      const provider = getProvider(promptPreviewMatch[1]);
      if (!provider) {
        return json(res, { ok: false, error: "Provider not found" }, 404);
      }
      try {
        let analysisConfig = appConfig.analysis;
        let targetId = url.searchParams.get("target") || "";
        if (req.method === "POST") {
          if (!isTrustedLocalJsonRequest(req)) {
            return json(res, { ok: false, error: "Prompt preview requests must be same-origin JSON from loopback" }, 403);
          }
          const body = await readBody(req);
          const validationErrors = validateUserConfig(body?.config);
          if (validationErrors.length) {
            return json(res, {
              ok: false,
              error: "Invalid configuration",
              validationErrors
            }, 400);
          }
          analysisConfig = body.config.analysis;
          targetId = typeof body.target === "string" ? body.target : "";
        }
        const preview = buildAnalysisPromptPreview({
          provider,
          analysisConfig,
          configPath: appConfig.configPath,
          targetId
        });
        return json(res, { ok: true, preview });
      } catch (error) {
        return json(res, {
          ok: false,
          error: error?.message || "Failed to build analyzer prompt preview"
        }, 409);
      }
    }

    if (req.method === "POST" && pathname === "/api/settings") {
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
        return json(res, {
          ok: true,
          configPath: appConfig.configPath,
          restartRequiredKeys,
          terminalLaunchAllowed: Boolean(appConfig.allowTerminalLaunch),
          ignoredKeys: Object.prototype.hasOwnProperty.call(nextConfig, "allowTerminalLaunch")
            ? ["allowTerminalLaunch"]
            : []
        });
      } catch (error) {
        console.error("Settings save error:", error?.message || error);
        return json(res, {
          ok: false,
          error: error?.message || "Failed to save settings",
          validationErrors: error?.validationErrors || []
        }, 500);
      }
    }

    const prefixedMutationMatch = pathname.match(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/(star|rename|delete|restore|permanent-delete)$/);
    const legacyMutationMatch = pathname.match(/^\/api\/session\/([^/]+)\/(star|rename|delete|restore|permanent-delete)$/);
    if (req.method === "POST" && (prefixedMutationMatch || legacyMutationMatch)) {
      const providerId = prefixedMutationMatch?.[1] || "opencode";
      const adapter = providerMap.get(providerId);
      if (!supportsLocalManagement(adapter)) {
        return json(res, { ok: false, error: "Not supported for this provider" }, 501);
      }

      const rawId = prefixedMutationMatch?.[2] || legacyMutationMatch[1];
      const id = safeDecodeId(rawId);
      if (!id) return json(res, { ok: false, error: "Invalid session ID" }, 400);
      const action = prefixedMutationMatch?.[3] || legacyMutationMatch[2];
      if (adapter && !adapter.getSession(id)) {
        return json(res, { ok: false, error: "Session not found" }, 404);
      }
      try {
        if (action === "star") {
          const starred = toggleStar(providerId, id);
          return json(res, { ok: true, starred });
        }
        if (action === "rename") {
          const body = await readBody(req);
          renameSession(providerId, id, body.title || "");
          return json(res, { ok: true });
        }
        if (action === "delete") {
          softDelete(providerId, id);
          return json(res, { ok: true });
        }
        if (action === "restore") {
          restoreSession(providerId, id);
          return json(res, { ok: true });
        }
        if (action === "permanent-delete") {
          permanentDelete(providerId, id);
          return json(res, { ok: true });
        }
      } catch (error) {
        console.error("Mutation error:", error?.message || error);
        return json(res, { ok: false, error: "Internal server error" }, 500);
      }
    }

    const prefixedBatchMatch = pathname.match(/^\/api\/([a-z][a-z0-9-]*)\/batch$/);
    if (req.method === "POST" && (pathname === "/api/batch" || prefixedBatchMatch)) {
      const providerId = prefixedBatchMatch?.[1] || "opencode";
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
        return json(res, { ok: true, affected });
      } catch (error) {
        console.error("Mutation error:", error?.message || error);
        return json(res, { ok: false, error: "Internal server error" }, 500);
      }
    }

    if (req.method === "POST" && pathname === "/api/reindex") {
      try {
        getIndexDb();
        const results = [];
        for (const provider of availableProviders) {
          const startTime = Date.now();
          const sessions = [];
          for await (const session of provider.scan()) {
            sessions.push(session);
          }
          clearIndex(provider.id);
          upsertIndex(provider.id, sessions);
          results.push({ provider: provider.id, indexed: sessions.length, tookMs: Date.now() - startTime });
        }
        return json(res, { ok: true, results });
      } catch (error) {
        console.error("Mutation error:", error?.message || error);
        return json(res, { ok: false, error: "Internal server error" }, 500);
      }
    }

    const resumeMatch = pathname.match(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/resume$/);
    if (req.method === "POST" && resumeMatch) {
      if (!isTrustedLocalJsonRequest(req)) {
        return json(res, { ok: false, error: "Resume requests must be same-origin JSON from loopback" }, 403);
      }
      if (!appConfig.allowTerminalLaunch) {
        return json(res, { ok: false, error: "Terminal launch is disabled" }, 403);
      }

      const providerId = resumeMatch[1];
      const sessionId = safeDecodeId(resumeMatch[2]);
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
        launchResumeCommand(command, appConfig.resumeShell);
        return json(res, { ok: true });
      } catch (error) {
        console.error("Resume launch error:", error?.message || error);
        return json(res, { ok: false, error: error?.message || "Failed to launch terminal" }, 500);
      }
    }

    const analysisMatch = pathname.match(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/analyze$/);
    if (req.method === "POST" && analysisMatch) {
      if (!isTrustedLocalJsonRequest(req)) {
        return json(res, { ok: false, error: "Analysis requests must be same-origin JSON from loopback" }, 403);
      }
      if (!appConfig.allowTerminalLaunch) {
        return json(res, { ok: false, error: "Terminal launch is disabled" }, 403);
      }

      const providerId = analysisMatch[1];
      const sessionId = safeDecodeId(analysisMatch[2]);
      const adapter = providerMap.get(providerId);
      if (!sessionId || !adapter) {
        return json(res, { ok: false, error: "Session not found" }, 404);
      }
      const session = adapter.getSession(sessionId);
      if (!session) {
        return json(res, { ok: false, error: "Session not found" }, 404);
      }

      try {
        const body = await readBody(req);
        const requestedTargets: unknown[] = Array.isArray(body.targets)
          ? body.targets
          : typeof body.target === "string"
            ? [body.target]
            : [];
        const targetIds: string[] = [...new Set<string>(
          requestedTargets
            .filter((target): target is string => typeof target === "string")
            .map((target) => target.trim())
            .filter(Boolean)
        )];
        const selectedTargets: string[] = targetIds.length
          ? targetIds
          : getDefaultAnalysisTargetIds(adapter, appConfig.analysis);
        if (!selectedTargets.length) {
          return json(res, { ok: false, error: "Select at least one analysis target" }, 400);
        }
        if (selectedTargets.length > 16) {
          return json(res, { ok: false, error: "Too many analysis targets selected" }, 400);
        }
        const action = getSessionAnalysisAction(
          adapter,
          sessionId,
          session.directory,
          appConfig.analysis
        );
        const actionTargets = new Map((action?.targets || []).map((target) => [target.id, target]));
        const unknownTarget = selectedTargets.find((targetId) => !actionTargets.has(targetId));
        if (unknownTarget) {
          return json(res, { ok: false, error: `Analysis target is unavailable: ${unknownTarget}` }, 400);
        }
        const unavailableTarget = selectedTargets.find((targetId) => !actionTargets.get(targetId)?.available);
        if (unavailableTarget) {
          return json(res, {
            ok: false,
            error: "Configured analysis executable was not found",
            target: unavailableTarget
          }, 409);
        }
        const runs = selectedTargets.map((targetId) => prepareSessionAnalysis({
          provider: adapter,
          sessionId,
          analysisConfig: appConfig.analysis,
          metaDir: appConfig.metaDir,
          configPath: appConfig.configPath,
          targetId
        }));
        for (const run of runs) {
          launchSessionAnalysis(run, appConfig.resumeShell);
        }
        return json(res, {
          ok: true,
          runId: runs[0].runId,
          runDir: runs[0].runDir,
          target: runs[0].target,
          targets: runs.map((run) => run.target),
          runs: runs.map((run) => ({
            runId: run.runId,
            runDir: run.runDir,
            target: run.target
          }))
        });
      } catch (error) {
        console.error("Session analysis launch error:", error?.message || error);
        return json(res, { ok: false, error: error?.message || "Failed to launch session analysis" }, 500);
      }
    }

    const analysisOutputMatch = pathname.match(
      /^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/analyses\/([^/]+)\/outputs\/(report|evaluation|proposals)$/
    );
    if (req.method === "GET" && analysisOutputMatch) {
      const providerId = analysisOutputMatch[1];
      const sessionId = safeDecodeId(analysisOutputMatch[2]);
      const runId = safeDecodeId(analysisOutputMatch[3]);
      const outputId = analysisOutputMatch[4];
      const adapter = providerMap.get(providerId);
      if (!sessionId || !runId || !adapter) {
        return json(res, { ok: false, error: "Analysis output not found" }, 404);
      }
      try {
        const session = adapter.getSession(sessionId);
        if (!session) {
          return json(res, { ok: false, error: "Analysis output not found" }, 404);
        }
        const runs = listSessionAnalysisRuns({
          providerId,
          sessionId,
          directory: session.directory,
          analysisConfig: appConfig.analysis,
          metaDir: appConfig.metaDir,
          limit: 50
        });
        const run = runs.find((item) => item.runId === runId);
        const output = run?.outputs?.[outputId];
        if (!run || !output?.available) {
          return json(res, { ok: false, error: "Analysis output not found" }, 404);
        }
        const outputPath = path.join(run.runDir, output.relativePath || output.fileName);
        const outputStat = lstatSync(outputPath);
        if (!outputStat.isFile() || outputStat.isSymbolicLink() || outputStat.size > 16 * 1024 * 1024) {
          return json(res, { ok: false, error: "Analysis output not found" }, 404);
        }
        const contentType = output.fileName.endsWith(".json")
          ? "application/json; charset=utf-8"
          : "text/markdown; charset=utf-8";
        const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline";
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Disposition": `${disposition}; filename="${output.fileName}"`,
          "X-Content-Type-Options": "nosniff"
        });
        res.end(readFileSync(outputPath));
        return;
      } catch (error) {
        console.error("Analysis output error:", error?.message || error);
        return json(res, { ok: false, error: "Failed to read analysis output" }, 500);
      }
    }

    const analysesMatch = pathname.match(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/analyses$/);
    if (req.method === "GET" && analysesMatch) {
      const providerId = analysesMatch[1];
      const sessionId = safeDecodeId(analysesMatch[2]);
      const adapter = providerMap.get(providerId);
      if (!sessionId || !adapter) {
        return json(res, { ok: false, error: "Session not found" }, 404);
      }
      try {
        const session = adapter.getSession(sessionId);
        if (!session) {
          return json(res, { ok: false, error: "Session not found" }, 404);
        }
        const runs = listSessionAnalysisRuns({
          providerId,
          sessionId,
          directory: session.directory,
          analysisConfig: appConfig.analysis,
          metaDir: appConfig.metaDir,
          limit: 10
        });
        return json(res, { ok: true, runs });
      } catch (error) {
        console.error("Analysis status error:", error?.message || error);
        return json(res, { ok: false, error: "Failed to read analysis status" }, 500);
      }
    }

    if (req.method !== "GET") {
      send(res, 405, "Method not allowed", "text/plain; charset=utf-8");
      return;
    }

    const apiSessionsMatch = pathname.match(/^\/api\/([a-z][a-z0-9-]*)\/sessions$/);
    if (apiSessionsMatch) {
      const providerId = apiSessionsMatch[1];
      const adapter = providerMap.get(providerId);
      if (!adapter) {
        const missing = missingProviderResponse(providerId);
        return json(res, missing.body, missing.status);
      }

      try {
        const apiLimit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 30), 100);
        const apiOffset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
        const range = url.searchParams.get("range") || "";
        const query = url.searchParams.get("q") || "";
        const project = url.searchParams.get("project") || "";
        const searchMode = url.searchParams.get("mode") || "list";

        if (usesSqliteSessionStore(adapter)) {
          const dbPath = adapter.getDataPath();
          const metaMap = getAllMeta(providerId);
          const excludedIds = getExcludedIds(providerId);

          let sessions;
          let total;
          if (query && searchMode === "content") {
            const results = getSearchResults(query, apiLimit, apiOffset, dbPath);
            sessions = enrichSessionList(results.sessions, metaMap, excludedIds);
            total = results.total;
          } else {
            const results = listSessions(apiLimit, apiOffset, query, range, dbPath, project);
            sessions = enrichSessionList(results.sessions, metaMap, excludedIds);
            total = results.total;
          }

          return json(res, {
            sessions: sessions.map((session) => toApiSessionShape(normalizeSessionRecord(session))),
            total,
            offset: apiOffset,
            hasMore: apiOffset + sessions.length < total
          });
        }

        let sessions;
        let total;
        if (query && searchMode === "content") {
          const results = getProviderSearchResults(adapter, query, apiLimit, apiOffset);
          sessions = results.sessions;
          total = results.total;
        } else {
          const indexed = getIndexedSessions(providerId, apiLimit, apiOffset, range, query, project);
          sessions = indexed.sessions.map((session) => normalizeSessionRecord(session));
          total = indexed.total;
        }

        return json(res, {
          sessions: sessions.map((session) => toApiSessionShape(session)),
          total,
          offset: apiOffset,
          hasMore: apiOffset + sessions.length < total
        });
      } catch (err) {
        console.error(`Route error: ${err.message}`);
        return json(res, { error: "Internal server error" }, 500);
      }
    }

    const apiSessionExportMatch = pathname.match(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/export$/);
    if (apiSessionExportMatch) {
      const providerId = apiSessionExportMatch[1];
      const id = decodeURIComponent(apiSessionExportMatch[2]);
      const adapter = providerMap.get(providerId);
      if (!adapter) {
        const missing = missingProviderResponse(providerId);
        return json(res, missing.body, missing.status);
      }

      try {
        const format = url.searchParams.get("format") || "md";
        let session;
        let messages;
        let partsByMessage;

        if (usesSqliteSessionStore(adapter)) {
          const dbPath = adapter.getDataPath();
          const metaMap = getAllMeta(providerId);
          const rawSession = getSession(id, dbPath);
          if (!rawSession) {
            return json(res, { ok: false, error: "Not found" }, 404);
          }
          session = normalizeSessionRecord(enrichSession(rawSession, metaMap));
          messages = getMessages(id, dbPath).map((message) => ({ ...message, data: safeJsonParse(message.data) }));
          partsByMessage = loadPartsByMessage(messages, dbPath);
        } else {
          const rawSession = adapter.getSession(id);
          if (!rawSession) {
            return json(res, { ok: false, error: "Not found" }, 404);
          }
          session = normalizeSessionRecord(rawSession);
          const mapped = buildPartsFromProviderMessages(adapter.getMessages(id));
          messages = mapped.messages;
          partsByMessage = mapped.partsByMessage;
        }

        if (format === "json") {
          const filename = `session-${id.slice(0, 8)}.json`;
          const sessionTree = adapter.getSessionTree?.(id) || null;
          const sessionContainer = adapter.getSessionContainer?.(id) || null;
          const sessionMetrics = adapter.getSessionMetrics?.(id) || null;
          const sessionFlow = adapter.getSessionFlow?.(id) || null;
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`
          });
          return res.end(JSON.stringify({
            session,
            tree: sessionTree,
            container: sessionContainer,
            metrics: sessionMetrics,
            flow: sessionFlow,
            messages: messages.map((message) => ({
              ...message,
              parts: (partsByMessage.get(message.id) || []).map((part) => part.data)
            }))
          }, null, 2));
        }

        const md = renderMarkdownExport(session, messages, partsByMessage);
        const filename = `session-${id.slice(0, 8)}.md`;
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`
        });
        return res.end(md);
      } catch (err) {
        console.error(`Route error: ${err.message}`);
        return json(res, { error: "Internal server error" }, 500);
      }
    }

    const apiSessionDetailMatch = pathname.match(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)$/);
    if (apiSessionDetailMatch) {
      const providerId = apiSessionDetailMatch[1];
      const sessionId = decodeURIComponent(apiSessionDetailMatch[2]);
      const adapter = providerMap.get(providerId);
      if (!adapter) {
        const missing = missingProviderResponse(providerId);
        return json(res, missing.body, missing.status);
      }

      try {
        if (usesSqliteSessionStore(adapter)) {
          const dbPath = adapter.getDataPath();
          const metaMap = getAllMeta(providerId);
          const session = getSession(sessionId, dbPath);
          if (!session) {
            return json(res, { ok: false, error: "Not found" }, 404);
          }
          const enrichedSession = normalizeSessionRecord(enrichSession(session, metaMap));
          const messages = getMessages(sessionId, dbPath).map((message) => ({ ...message, data: safeJsonParse(message.data) }));
          const partsByMessage = loadPartsByMessage(messages, dbPath);
          const sessionTree = adapter.getSessionTree?.(sessionId) || null;
          const sessionContainer = adapter.getSessionContainer?.(sessionId) || null;
          const sessionMetrics = adapter.getSessionMetrics?.(sessionId) || null;
          const sessionFlow = adapter.getSessionFlow?.(sessionId) || null;
          return json(res, {
            session: enrichedSession,
            tree: sessionTree,
            container: sessionContainer,
            metrics: sessionMetrics,
            flow: sessionFlow,
            messages: messages.map((message) => ({
              ...message,
              parts: (partsByMessage.get(message.id) || []).map((part) => part.data)
            }))
          });
        }

        const session = adapter.getSession(sessionId);
        if (!session) {
          return json(res, { ok: false, error: "Not found" }, 404);
        }

        return json(res, {
          session: normalizeSessionRecord(session),
          tree: adapter.getSessionTree?.(sessionId) || null,
          container: adapter.getSessionContainer?.(sessionId) || null,
          metrics: adapter.getSessionMetrics?.(sessionId) || null,
          flow: adapter.getSessionFlow?.(sessionId) || null,
          messages: adapter.getMessages(sessionId)
        });
      } catch (err) {
        console.error(`Route error: ${err.message}`);
        return json(res, { error: "Internal server error" }, 500);
      }
    }

    const apiSessionMetricsMatch = pathname.match(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/metrics$/);
    if (apiSessionMetricsMatch) {
      const providerId = apiSessionMetricsMatch[1];
      const sessionId = decodeURIComponent(apiSessionMetricsMatch[2]);
      const adapter = providerMap.get(providerId);
      if (!adapter) {
        const missing = missingProviderResponse(providerId);
        return json(res, missing.body, missing.status);
      }

      if (!supportsStructuredSessionViews(adapter)) {
        return json(res, { sessionId, totals: null, tools: [], steps: [] });
      }

      try {
        const metrics = adapter.getSessionMetrics?.(sessionId);
        if (!metrics) {
          return json(res, { ok: false, error: "Not found" }, 404);
        }
        return json(res, metrics);
      } catch (err) {
        console.error(`Route error: ${err.message}`);
        return json(res, { error: "Internal server error" }, 500);
      }
    }

    const apiSessionFlowMatch = pathname.match(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/flow$/);
    if (apiSessionFlowMatch) {
      const providerId = apiSessionFlowMatch[1];
      const sessionId = decodeURIComponent(apiSessionFlowMatch[2]);
      const adapter = providerMap.get(providerId);
      if (!adapter) {
        const missing = missingProviderResponse(providerId);
        return json(res, missing.body, missing.status);
      }

      if (!supportsStructuredSessionViews(adapter)) {
        return json(res, { sessionId, root: null, summary: null });
      }

      try {
        const flow = adapter.getSessionFlow?.(sessionId);
        if (!flow) {
          return json(res, { ok: false, error: "Not found" }, 404);
        }
        return json(res, flow);
      } catch (err) {
        console.error(`Route error: ${err.message}`);
        return json(res, { error: "Internal server error" }, 500);
      }
    }

    const apiSessionTraceMatch = pathname.match(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/trace$/);
    if (apiSessionTraceMatch) {
      const providerId = apiSessionTraceMatch[1];
      const sessionId = decodeURIComponent(apiSessionTraceMatch[2]);
      const adapter = providerMap.get(providerId);
      if (!adapter) {
        const missing = missingProviderResponse(providerId);
        return json(res, missing.body, missing.status);
      }

      try {
        if (supportsStructuredSessionViews(adapter) && adapter.getTrace) {
          return json(res, {
            ...adapter.getTrace(sessionId),
            flow: adapter.getSessionFlow?.(sessionId) || null
          });
        }

        return json(res, {
          steps: [],
          summary: { totalSteps: 0, totalSpans: 0, totalDuration: 0, totalCost: 0, totalTokens: 0 }
        });
      } catch (err) {
        console.error(`Route error: ${err.message}`);
        return json(res, { error: "Internal server error" }, 500);
      }
    }

    const apiStatsMatch = pathname.match(/^\/api\/([a-z][a-z0-9-]*)\/stats$/);
    if (apiStatsMatch) {
      const providerId = apiStatsMatch[1];
      const adapter = providerMap.get(providerId);
      if (!adapter) {
        const missing = missingProviderResponse(providerId);
        return json(res, missing.body, missing.status);
      }

      try {
        if (usesSqliteSessionStore(adapter)) {
          const dbPath = adapter.getDataPath();
          const tokenStats = completeTokenStats(getTokenStats(30, dbPath), 30);
          return json(res, {
            ...getStats(dbPath),
            tokenStats,
            tokenTotal: tokenStats.reduce((sum, row) => sum + (Number(row.total_tokens) || 0), 0)
          });
        }

        const indexed = getIndexedSessions(providerId, 100000, 0, "").sessions;
        const totalMessages = indexed.reduce((sum, session) => sum + (Number(session.message_count) || 0), 0);
        const tokenStats = completeTokenStats(adapter.getTokenStats(30).map((row) => ({
          day: row.day,
          input_tokens: Number(row.inputTokens) || 0,
          output_tokens: Number(row.outputTokens) || 0,
          reasoning_tokens: Number(row.reasoningTokens) || 0,
          cache_read_tokens: Number(row.cacheReadTokens) || 0,
          cache_write_tokens: Number(row.cacheWriteTokens) || 0,
          total_tokens: Number(row.totalTokens) || 0,
          message_count: Number(row.messageCount) || 0
        })), 30);
        return json(res, {
          totalSessions: indexed.length,
          totalMessages,
          modelDistribution: [],
          tokenStats,
          tokenTotal: tokenStats.reduce((sum, row) => sum + (Number(row.total_tokens) || 0), 0)
        });
      } catch (err) {
        console.error(`Route error: ${err.message}`);
        return json(res, { error: "Internal server error" }, 500);
      }
    }

    if (!providerSegment) {
      send(res, 404, "<h1>Not found</h1>");
      return;
    }

    const currentProvider = getProvider(providerSegment);
    const adapter = providerMap.get(providerSegment);
    if (!currentProvider) {
      send(res, 404, "<h1>Provider not found</h1>");
      return;
    }

    const renderContext = {
      provider: providerSegment,
      providers: providerInfo,
      manageable: supportsLocalManagement(adapter)
    };

    if (subPath === "/settings") {
      const configDocument = readUserConfigDocument(appConfig.configPath);
      send(res, 200, renderSettingsPage({
        configPath: appConfig.configPath,
        configDocument,
        terminalLaunchAllowed: Boolean(appConfig.allowTerminalLaunch),
        providerName: currentProvider.name,
        resumeDefault: currentProvider.resumeCommand || null,
        providerAvailable: Boolean(adapter),
        ...renderContext
      }));
      return;
    }

    if (!adapter) {
      const dataPath = currentProvider.getDataPath();
      const unavailableReason = currentProvider.getUnavailableReason?.();
      send(res, 200, renderSessionsPage({
        sessions: [],
        total: 0,
        note: unavailableReason || `${currentProvider.name} data was not detected at ${dataPath}.`,
        providerAvailable: false,
        ...renderContext
      }));
      return;
    }

    if (subPath === "/") {
      try {
        const range = url.searchParams.get("range") || "";
        const query = url.searchParams.get("q") || "";
        const project = url.searchParams.get("project") || "";
        if (usesSqliteSessionStore(adapter)) {
          const dbPath = adapter.getDataPath();
          const { sessions, total } = listSessions(limit, offset, query, range, dbPath, project);
          const metaMap = getAllMeta(providerSegment);
          const excludedIds = getExcludedIds(providerSegment);
          const enrichedSessions = enrichSessionList(sessions, metaMap, excludedIds).map((session) => normalizeSessionRecord(session));
          const overviewStats = getStats(dbPath);
          const deletedCount = getDeletedIds(providerSegment).length;
          const projectOptions = listSessionProjects(query, range, dbPath);
          send(res, 200, renderSessionsPage({
            sessions: enrichedSessions,
            total,
            limit,
            offset,
            query,
            range,
            project,
            projectOptions,
            searchMode: "list",
            totalMessages: overviewStats.totalMessages,
            deletedCount,
            ...renderContext
          }));
          return;
        }

        const indexed = getIndexedSessions(providerSegment, limit, offset, range, query, project);
        const allIndexed = getIndexedSessions(providerSegment, 100000, 0, "").sessions;
        const totalMessages = allIndexed.reduce((sum, session) => sum + (Number(session.message_count) || 0), 0);
        const projectOptions = getIndexedSessionProjects(providerSegment, range, query);
        send(res, 200, renderSessionsPage({
          sessions: indexed.sessions.map((session) => normalizeSessionRecord(session)),
          total: indexed.total,
          limit,
          offset,
          query,
          range,
          project,
          projectOptions,
          searchMode: "list",
          totalMessages,
          deletedCount: 0,
          ...renderContext
        }));
        return;
      } catch (err) {
        console.error(`Route error: ${err.message}`);
        return json(res, { error: "Internal server error" }, 500);
      }
    }

    if (subPath === "/search") {
      try {
        const query = url.searchParams.get("q") || "";
        if (usesSqliteSessionStore(adapter)) {
          const dbPath = adapter.getDataPath();
          const results = getSearchResults(query, limit, offset, dbPath);
          const metaMap = getAllMeta(providerSegment);
          const excludedIds = getExcludedIds(providerSegment);
          const enrichedSessions = enrichSessionList(results.sessions, metaMap, excludedIds).map((session) => normalizeSessionRecord(session));
          send(res, 200, renderSessionsPage({ ...results, sessions: enrichedSessions, limit, offset, query, searchMode: "content", ...renderContext }));
          return;
        }

        const results = getProviderSearchResults(adapter, query, limit, offset);
        send(res, 200, renderSessionsPage({ ...results, limit, offset, query, searchMode: "content", ...renderContext }));
        return;
      } catch (err) {
        console.error(`Route error: ${err.message}`);
        return json(res, { error: "Internal server error" }, 500);
      }
    }

    if (subPath === "/stats") {
      try {
        if (usesSqliteSessionStore(adapter)) {
          const dbPath = adapter.getDataPath();
          const tokenStats = completeTokenStats(getTokenStats(30, dbPath), 30);
          const modelDistribution = getModelDistribution(dbPath);
          const dailySessions = getDailySessionCounts(30, dbPath);
          const overview = getStats(dbPath);
          send(res, 200, renderStatsPage({ tokenStats, modelDistribution, dailySessions, overview, ...renderContext }));
          return;
        }

        const indexed = getIndexedSessions(providerSegment, 100000, 0, "").sessions;
        const tokenStats = adapter.getTokenStats(30).map((row) => ({
          day: row.day,
          input_tokens: Number(row.inputTokens) || 0,
          output_tokens: Number(row.outputTokens) || 0,
          reasoning_tokens: Number(row.reasoningTokens) || 0,
          cache_read_tokens: Number(row.cacheReadTokens) || 0,
          cache_write_tokens: Number(row.cacheWriteTokens) || 0,
          total_tokens: Number(row.totalTokens) || 0,
          message_count: Number(row.messageCount) || 0
        }));
        const dailyMap = new Map();
        for (const session of indexed) {
          const day = new Date(Number(session.time_created) || 0).toISOString().slice(0, 10);
          dailyMap.set(day, (dailyMap.get(day) || 0) + 1);
        }
        const dailySessions = [...dailyMap.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([day, count]) => ({ day, count }));
        const overview = {
          totalSessions: indexed.length,
          totalMessages: indexed.reduce((sum, session) => sum + (Number(session.message_count) || 0), 0)
        };
        send(res, 200, renderStatsPage({ tokenStats: completeTokenStats(tokenStats, 30), modelDistribution: [], dailySessions, overview, ...renderContext }));
        return;
      } catch (err) {
        console.error(`Route error: ${err.message}`);
        return json(res, { error: "Internal server error" }, 500);
      }
    }

    if (subPath === "/trash") {
      if (!supportsLocalManagement(adapter)) {
        send(res, 404, "<h1>Not found</h1>");
        return;
      }
      try {
        const dbPath = adapter.getDataPath();
        const deletedIds = getDeletedIds(providerSegment);
        const sessions = getSessionsByIds(deletedIds, dbPath);
        const metaMap = getAllMeta(providerSegment);
        const enriched = sessions.map((session) => normalizeSessionRecord(enrichSession(session, metaMap)));
        send(res, 200, renderTrashPage({ sessions: enriched, ...renderContext }));
        return;
      } catch (err) {
        console.error(`Route error: ${err.message}`);
        return json(res, { error: "Internal server error" }, 500);
      }
    }

    if (subPath.startsWith("/session/")) {
      try {
        const sessionId = decodeURIComponent(subPath.slice("/session/".length));

        if (usesSqliteSessionStore(adapter)) {
          const dbPath = adapter.getDataPath();
          const session = getSession(sessionId, dbPath);
          if (!session) {
            send(res, 404, "<h1>Session not found</h1>");
            return;
          }

          const meta = getMeta(providerSegment, sessionId);
          const metaMap = getAllMeta(providerSegment);
          const excludedIds = getExcludedIds(providerSegment);
          const enrichedSession = normalizeSessionRecord(enrichSession(session, metaMap));
          const messages = getMessages(sessionId, dbPath).map((message) => ({
            ...message,
            data: safeJsonParse(message.data)
          }));
          const partsByMessage = loadPartsByMessage(messages, dbPath);
          const sessionTree = adapter.getSessionTree?.(sessionId) || null;
          const sessionMetrics = adapter.getSessionMetrics?.(sessionId) || null;
          const sessionFlow = adapter.getSessionFlow?.(sessionId) || null;
          const todos = getTodos(sessionId, dbPath);
          const { sessions: recentSessions } = listSessions(30, 0, "", "", dbPath);
          const enrichedRecentSessions = enrichSessionList(recentSessions, metaMap, excludedIds).map((item) => normalizeSessionRecord(item));
          const resumeCommand = getResumeCommand(adapter, sessionId, enrichedSession.directory, appConfig.resumeCommands);
          const analysisAction = getSessionAnalysisAction(adapter, sessionId, enrichedSession.directory, appConfig.analysis);
          const analysisRuns = listSessionAnalysisRuns({
            providerId: providerSegment,
            sessionId,
            directory: enrichedSession.directory,
            analysisConfig: appConfig.analysis,
            metaDir: appConfig.metaDir
          });
          send(res, 200, renderSessionPage({
            session: enrichedSession,
            sessionTree,
            sessionMetrics,
            sessionFlow,
            messages,
            partsByMessage,
            todos,
            recentSessions: enrichedRecentSessions,
            meta,
            resumeCommand,
            analysisAction,
            analysisRuns,
            terminalLaunchAllowed: Boolean(appConfig.allowTerminalLaunch),
            ...renderContext
          }));
          return;
        }

        const session = adapter.getSession(sessionId);
        if (!session) {
          send(res, 404, "<h1>Session not found</h1>");
          return;
        }

        const providerMessages = adapter.getMessages(sessionId);
        const { messages, partsByMessage } = buildPartsFromProviderMessages(providerMessages);
        const recentSessions = getIndexedSessions(providerSegment, 30, 0, "").sessions.map((item) => normalizeSessionRecord(item));
        const normalizedSession = normalizeSessionRecord(session);
        const resumeCommand = getResumeCommand(adapter, sessionId, normalizedSession.directory, appConfig.resumeCommands);
        const analysisAction = getSessionAnalysisAction(adapter, sessionId, normalizedSession.directory, appConfig.analysis);
        const analysisRuns = listSessionAnalysisRuns({
          providerId: providerSegment,
          sessionId,
          directory: normalizedSession.directory,
          analysisConfig: appConfig.analysis,
          metaDir: appConfig.metaDir
        });
        send(res, 200, renderSessionPage({
          session: normalizedSession,
          sessionTree: adapter.getSessionTree?.(sessionId) || null,
          sessionMetrics: adapter.getSessionMetrics?.(sessionId) || null,
          sessionFlow: adapter.getSessionFlow?.(sessionId) || null,
          messages,
          partsByMessage,
          todos: [],
          recentSessions,
          meta: null,
          resumeCommand,
          analysisAction,
          analysisRuns,
          terminalLaunchAllowed: Boolean(appConfig.allowTerminalLaunch),
          ...renderContext
        }));
        return;
      } catch (err) {
        console.error(`Route error: ${err.message}`);
        return json(res, { error: "Internal server error" }, 500);
      }
    }

    send(res, 404, "<h1>Not found</h1>");
  };

  try {
    // Index all providers
    const providers = getAvailableProviders();
    getIndexDb();
    for (const provider of providers) {
      try {
        const startTime = Date.now();
        const sessions = [];
        for await (const session of provider.scan()) {
          sessions.push(session);
        }
        upsertIndex(provider.id, sessions);
        console.log(`Indexed ${sessions.length} sessions for ${provider.id} in ${Date.now() - startTime}ms`);
      } catch (err) {
        console.error(`Failed to index ${provider.id}: ${err.message}`);
      }
    }

    // Cache provider data after indexing (providers don't change at runtime)
    availableProviders = providers;
    providerMap = new Map(availableProviders.map((provider) => [provider.id, provider]));
    const availableIds = new Set(availableProviders.map((p) => p.id));
    providerInfo = getAllProviders().map((p) => ({
      id: p.id,
      name: p.name,
      icon: p.icon,
      available: availableIds.has(p.id),
      manageable: supportsLocalManagement(p)
    }));

    const statsProvider = availableProviders.find((provider) => provider.id === "opencode")
      || availableProviders.find((provider) => usesSqliteSessionStore(provider));
    const stats = statsProvider ? getStats(statsProvider.getDataPath()) : { totalSessions: 0, totalMessages: 0 };
    const dbLog = statsProvider ? statsProvider.getDataPath() : appConfig.dbPath;
    const server = createServer(requestHandler);
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`OpenSessionViewer running at http://localhost:${PORT}`);
      console.log(`Language: ${getLocale()}`);
      console.log(`DB: ${dbLog}`);
      console.log(`${stats.totalSessions} sessions, ${stats.totalMessages} messages.`);
    });

    if (appConfig.open) {
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      import("node:child_process").then((cp) => cp.exec(`${cmd} http://localhost:${PORT}`));
    }
  } catch (error) {
    console.error("Failed to start:", error.message);
    process.exit(1);
  }
}
