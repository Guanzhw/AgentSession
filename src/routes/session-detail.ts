import { getMessages, getSession, getTodos } from "../db.js";
import { getAllMeta, getDeletedIds, getExcludedIds, getMeta } from "../meta.js";
import {
  getVisibleListResults,
  getIndexedListResults,
  normalizeSessionRecord,
  enrichSession,
  loadPartsByMessage,
  buildPartsFromProviderMessages,
  toApiSessionShape,
  completeTokenStats,
  getStarredIds
} from "../session-queries.js";
import {
  json,
  safeJsonParse,
  missingProviderResponse,
  send
} from "../server-helpers.js";
import { usesSqliteSessionStore, supportsStructuredSessionViews } from "../providers/kinds.js";
import { getResumeCommand } from "../resume.js";
import { getSessionAnalysisAction, listSessionAnalysisRuns } from "../analysis.js";
import { renderSessionPage, renderCanonicalFlowPanelContent } from "../views/session.js";
import { providerRenderContext } from "./provider-context.js";

export function registerSessionDetail(
  app: any,
  deps: {
    appConfig: any;
    providerMap: Map<string, any>;
    providerInfo: any[];
  }
) {
  const { appConfig, providerMap, providerInfo } = deps;

  // Session detail page (HTML)
  app.get("/:provider/session/:id", async (req: any, res: any, params: any) => {
    const providerSegment = params.provider;
    const sessionId = decodeURIComponent(params.id);
    const adapter = providerMap.get(providerSegment);

    if (!adapter) {
      return { status: 404, body: "<h1>Not found</h1>", contentType: "text/html; charset=utf-8" };
    }

    const renderContext = providerRenderContext(providerSegment, providerInfo, adapter);

    try {
      if (usesSqliteSessionStore(adapter)) {
        const dbPath = adapter.getDataPath();
        const session = getSession(sessionId, dbPath);
        if (!session) {
          return { status: 404, body: "<h1>Session not found</h1>", contentType: "text/html; charset=utf-8" };
        }

        const meta = getMeta(providerSegment, sessionId);
        const metaMap = getAllMeta(providerSegment);
        const excludedIds = getExcludedIds(providerSegment);
        const enrichedSession = normalizeSessionRecord(enrichSession(session, metaMap));
        const messages = getMessages(sessionId, dbPath).map((message: any) => ({
          ...message,
          data: safeJsonParse(message.data)
        }));
        const partsByMessage = loadPartsByMessage(messages, dbPath);
        const sessionTree = adapter.getSessionTree?.(sessionId) || null;
        const sessionMetrics = adapter.getSessionMetrics?.(sessionId) || null;
        const todos = getTodos(sessionId, dbPath);
        const recentSessions = getVisibleListResults({
          dbPath,
          metaMap,
          excludedIds,
          limit: 30,
          offset: 0
        }).sessions;
        const enrichedRecentSessions = recentSessions.map((item: any) => normalizeSessionRecord(item));
        const resumeCommand = getResumeCommand(adapter, sessionId, enrichedSession.directory, appConfig.resumeCommands);
        const analysisAction = getSessionAnalysisAction(adapter, sessionId, enrichedSession.directory, appConfig.analysis);
        const analysisRuns = listSessionAnalysisRuns({
          provider: adapter,
          providerId: providerSegment,
          sessionId,
          directory: enrichedSession.directory,
          analysisConfig: appConfig.analysis,
          metaDir: appConfig.metaDir
        });
        return {
          status: 200,
          body: renderSessionPage({
            session: enrichedSession,
            sessionTree,
            sessionMetrics,
            messages,
            partsByMessage,
            todos,
            recentSessions: enrichedRecentSessions,
            meta,
            resumeCommand,
            analysisAction,
            analysisRuns,
            terminalLaunchAllowed: Boolean(appConfig.allowTerminalLaunch),
            flowLazyUrl: adapter.getSessionFlow ? `/api/${providerSegment}/session/${encodeURIComponent(sessionId)}/flow-panel` : "",
            ...renderContext
          }),
          contentType: "text/html; charset=utf-8"
        };
      }

      const session = adapter.getSession(sessionId);
      if (!session) {
        return { status: 404, body: "<h1>Session not found</h1>", contentType: "text/html; charset=utf-8" };
      }

      const providerMessages = adapter.getMessages(sessionId);
      const { messages, partsByMessage } = buildPartsFromProviderMessages(providerMessages);
      const meta = getMeta(providerSegment, sessionId);
      const metaMap = getAllMeta(providerSegment);
      const excludedIds = getExcludedIds(providerSegment);
      const recentSessions = getIndexedListResults({
        providerId: providerSegment,
        metaMap,
        excludedIds,
        limit: 30,
        offset: 0
      }).sessions.map((item: any) => normalizeSessionRecord(item));
      const normalizedSession = normalizeSessionRecord(enrichSession(session, metaMap));
      const resumeCommand = getResumeCommand(adapter, sessionId, normalizedSession.directory, appConfig.resumeCommands);
      const analysisAction = getSessionAnalysisAction(adapter, sessionId, normalizedSession.directory, appConfig.analysis);
      const analysisRuns = listSessionAnalysisRuns({
        provider: adapter,
        providerId: providerSegment,
        sessionId,
        directory: normalizedSession.directory,
        analysisConfig: appConfig.analysis,
        metaDir: appConfig.metaDir
      });
      return {
        status: 200,
        body: renderSessionPage({
          session: normalizedSession,
          sessionTree: adapter.getSessionTree?.(sessionId) || null,
          sessionMetrics: adapter.getSessionMetrics?.(sessionId) || null,
          messages,
          partsByMessage,
          todos: [],
          recentSessions,
          meta,
          resumeCommand,
          analysisAction,
          analysisRuns,
          terminalLaunchAllowed: Boolean(appConfig.allowTerminalLaunch),
          flowLazyUrl: adapter.getSessionFlow ? `/api/${providerSegment}/session/${encodeURIComponent(sessionId)}/flow-panel` : "",
          ...renderContext
        }),
        contentType: "text/html; charset=utf-8"
      };
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      return { status: 500, body: JSON.stringify({ error: "Internal server error" }), contentType: "application/json; charset=utf-8" };
    }
  });

  // API: session detail
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)$/, async (_req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const sessionId = decodeURIComponent(match[2]);
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
        const messages = getMessages(sessionId, dbPath).map((message: any) => ({ ...message, data: safeJsonParse(message.data) }));
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
          messages: messages.map((message: any) => ({
            ...message,
            parts: (partsByMessage.get(message.id) || []).map((part: any) => part.data)
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
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      return json(res, { error: "Internal server error" }, 500);
    }
  });

  // API: session export
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/export$/, async (req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const id = decodeURIComponent(match[2]);
    const adapter = providerMap.get(providerId);
    if (!adapter) {
      const missing = missingProviderResponse(providerId);
      return json(res, missing.body, missing.status);
    }

    try {
      const url = new URL(req.url || "/", `http://localhost:${appConfig.port}`);
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
        messages = getMessages(id, dbPath).map((message: any) => ({ ...message, data: safeJsonParse(message.data) }));
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
        const body = JSON.stringify({
          session,
          tree: sessionTree,
          container: sessionContainer,
          metrics: sessionMetrics,
          flow: sessionFlow,
          messages: messages.map((message: any) => ({
            ...message,
            parts: (partsByMessage.get(message.id) || []).map((part: any) => part.data)
          }))
        }, null, 2);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`
        });
        res.end(body);
        return;
      }

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

      const md = lines.join("\n");
      const filename = `session-${id.slice(0, 8)}.md`;
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`
      });
      res.end(md);
      return;
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      if (res.headersSent || res.writableEnded) {
        if (!res.writableEnded && typeof res.destroy === "function") {
          res.destroy(err);
        }
        return;
      }
      return json(res, { error: "Internal server error" }, 500);
    }
  });

  // API: session metrics
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/metrics$/, async (_req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const sessionId = decodeURIComponent(match[2]);
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
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      return json(res, { error: "Internal server error" }, 500);
    }
  });

  // API: flow panel (HTML)
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/flow-panel$/, async (_req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const sessionId = decodeURIComponent(match[2]);
    const adapter = providerMap.get(providerId);
    if (!adapter) {
      const missing = missingProviderResponse(providerId);
      return json(res, missing.body, missing.status);
    }

    if (!supportsStructuredSessionViews(adapter)) {
      return send(res, 200, renderCanonicalFlowPanelContent(null));
    }

    try {
      const flow = adapter.getSessionFlow?.(sessionId);
      if (!flow) {
        return send(res, 200, renderCanonicalFlowPanelContent(null));
      }
      return send(res, 200, renderCanonicalFlowPanelContent(flow));
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      return json(res, { error: "Internal server error" }, 500);
    }
  });

  // API: flow JSON
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/flow$/, async (_req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const sessionId = decodeURIComponent(match[2]);
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
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      return json(res, { error: "Internal server error" }, 500);
    }
  });

  // API: trace
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/trace$/, async (_req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const sessionId = decodeURIComponent(match[2]);
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
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      return json(res, { error: "Internal server error" }, 500);
    }
  });
}
