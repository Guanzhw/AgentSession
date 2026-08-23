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
  safeDecodeId,
  safeJsonParse,
  missingProviderResponse
} from "../server-helpers.js";
import {
  supportsAgentLoopViews,
  supportsSessionProtocol,
  protocolCapabilityDescriptors,
  supportsSessionTrace,
  supportsSystemPromptEvidence,
  usesOpenCodeStatsStore
} from "../providers/kinds.js";
import { getResumeCommand } from "../resume.js";
import { renderSessionPage } from "../views/session.js";
import type { SessionProtocol } from "../providers/shared/session-protocol.js";
import { renderRuntimeWorkbench } from "../views/runtime-workbench.js";
import { renderProgressiveContent } from "../views/components.js";
import { providerRenderContext } from "./provider-context.js";
import { parseSessionNavigationContext } from "../navigation-context.js";
import {
  buildRuntimeGraph,
  getRuntimeProtocol,
  ProtocolRuntimeError,
  queryRuntimeEvents,
  summarizeRuntimeProtocol
} from "../protocol-runtime.js";

export function registerSessionDetail(
  app: any,
  deps: {
    appConfig: any;
    providerMap: Map<string, any>;
    providerInfo: any[];
  }
) {
  const { appConfig, providerMap, providerInfo } = deps;

  const runtimeRenderData = (adapter: any, sessionId: string, session: Record<string, unknown>) => {
    try {
      const protocol = getRuntimeProtocol(adapter, sessionId, session);
      return {
        protocol: protocol as SessionProtocol,
        summary: summarizeRuntimeProtocol(protocol, adapter.protocolCapabilities),
        graph: buildRuntimeGraph(adapter, protocol, { depth: 0, maxNodes: 100 }),
        eventNextCursor: queryRuntimeEvents(protocol, { limit: 50 }).nextCursor,
        storageDiagnostic: adapter.getStorageDiagnostic?.() || null
      };
    } catch (error) {
      return {
        protocol: null,
        summary: {
          version: 2,
          completeness: "partial",
          counts: { events: 0, relationships: 0, tasks: 0, agentRuns: 0, contextArtifacts: 0, branches: 0 },
          capabilities: {}
        },
        storageDiagnostic: adapter.getStorageDiagnostic?.() || null,
        runtimeError: {
          code: error instanceof ProtocolRuntimeError ? error.code : "runtime_unavailable",
          message: error instanceof ProtocolRuntimeError
            ? "Runtime protocol is unavailable for this session."
            : "Runtime protocol could not be loaded."
        }
      };
    }
  };

  const runtimeError = (res: any, error: unknown) => {
    if (error instanceof ProtocolRuntimeError) {
      const status = error.code === "invalid_input" ? 400 : 404;
      return json(res, { ok: false, error: error.message, code: error.code }, status);
    }
    console.error(`Runtime protocol route error: ${error instanceof Error ? error.message : String(error)}`);
    return json(res, { ok: false, error: "Internal server error" }, 500);
  };

  const listParam = (params: URLSearchParams, name: string) => (
    params.getAll(name)
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean)
  );

  const findPart = (container: any, partId: string): any => {
    if (!container || typeof container !== "object") return null;
    for (const message of container.messages || []) {
      for (const part of message.parts || []) {
        if (String(part.id) === partId) return part;
        for (const child of part.childSessions || []) {
          const match = findPart(child, partId);
          if (match) return match;
        }
      }
    }
    for (const child of container.detachedChildren || []) {
      const match = findPart(child, partId);
      if (match) return match;
    }
    return null;
  };

  // Session detail page (HTML)
  app.get("/:provider/session/:id", async (req: any, res: any, params: any) => {
    const providerSegment = params.provider;
    const sessionId = decodeURIComponent(params.id);
    const adapter = providerMap.get(providerSegment);

    if (!adapter) {
      return { status: 404, body: "<h1>Not found</h1>", contentType: "text/html; charset=utf-8" };
    }

    const renderContext = providerRenderContext(providerSegment, providerInfo, adapter);
    const navigationContext = parseSessionNavigationContext(new URL(req.url || "/", `http://localhost:${appConfig.port}`).searchParams.get("from"));

    try {
      if (usesOpenCodeStatsStore(adapter)) {
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
        const runtime = runtimeRenderData(adapter, sessionId, enrichedSession);
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
            runtimeWorkbench: renderRuntimeWorkbench(runtime, providerSegment, sessionId),
            terminalLaunchAllowed: Boolean(appConfig.allowTerminalLaunch),
            navigationContext,
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
      const runtime = runtimeRenderData(adapter, sessionId, normalizedSession);
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
          runtimeWorkbench: renderRuntimeWorkbench(runtime, providerSegment, sessionId),
          terminalLaunchAllowed: Boolean(appConfig.allowTerminalLaunch),
          navigationContext,
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
      if (usesOpenCodeStatsStore(adapter)) {
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
        return json(res, {
          session: enrichedSession,
          tree: sessionTree,
          container: sessionContainer,
          metrics: sessionMetrics,
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
        messages: adapter.getMessages(sessionId)
      });
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      return json(res, { error: "Internal server error" }, 500);
    }
  });

  // API: one bounded continuation chunk for reasoning or tool content.
  // The initial HTML never embeds the remainder, keeping long sessions
  // bounded while the user can still retrieve the complete source value.
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/content$/, async (req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const sessionId = safeDecodeId(match[2]);
    const adapter = providerMap.get(providerId);
    if (!adapter) {
      const missing = missingProviderResponse(providerId);
      return json(res, missing.body, missing.status);
    }
    if (!sessionId) {
      return json(res, { ok: false, error: "Invalid session id" }, 404);
    }

    const params = new URL(req.url || "/", `http://localhost:${appConfig.port}`).searchParams;
    const partId = params.get("part") || "";
    const field = params.get("field");
    const offset = Number(params.get("offset") || 0);
    if (!partId || !["text", "reasoning", "input", "output"].includes(String(field)) || !Number.isSafeInteger(offset) || offset < 0) {
      return json(res, { ok: false, error: "Invalid content request" }, 400);
    }

    try {
      let part = findPart(adapter.getSessionContainer?.(sessionId), partId);
      if (!part) {
        const raw = buildPartsFromProviderMessages(adapter.getMessages(sessionId));
        part = [...raw.partsByMessage.values()].flat().find((candidate: any) => String(candidate.id) === partId) || null;
      }
      const data = part?.data && typeof part.data === "object" ? part.data : null;
      if (!data) {
        return json(res, { ok: false, error: "Content not found" }, 404);
      }

      let value: any;
      let format: "markdown" | "plain" | "auto";
      let limit: number;
      if (field === "text" && data.type === "text") {
        value = data.text || "";
        format = "markdown";
        limit = 12000;
      } else if (field === "reasoning" && data.type === "reasoning") {
        value = data.text || "";
        format = "markdown";
        limit = 6000;
      } else if (field === "input" && data.type === "tool") {
        value = data.state?.input;
        format = "plain";
        limit = 3000;
      } else if (field === "output" && data.type === "tool") {
        value = data.state?.status === "error"
          ? (data.state?.error ?? data.state?.output)
          : data.state?.output;
        format = "auto";
        limit = 3000;
      } else {
        return json(res, { ok: false, error: "Content not found" }, 404);
      }
      const page = renderProgressiveContent(value, format, offset, limit);
      return json(res, { ok: true, ...page });
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

      if (usesOpenCodeStatsStore(adapter)) {
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
        const body = JSON.stringify({
          session,
          tree: sessionTree,
          container: sessionContainer,
          metrics: sessionMetrics,
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

    if (!supportsAgentLoopViews(adapter)) {
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

  // API: standardized session protocol (read-only). Exposes capability
  // descriptors plus the typed events/relationships/tasks/agent runs/context
  // artifacts. Unknown sessions, unknown providers, and providers without a
  // protocol accessor all answer 404; IDs are decoded defensively.
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/protocol$/, async (_req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const sessionId = safeDecodeId(match[2]);
    const adapter = providerMap.get(providerId);
    if (!adapter) {
      const missing = missingProviderResponse(providerId);
      return json(res, missing.body, missing.status);
    }
    if (!sessionId) {
      return json(res, { ok: false, error: "Invalid session id" }, 404);
    }
    if (!supportsSessionProtocol(adapter)) {
      return json(res, { ok: false, error: "Session protocol not supported" }, 404);
    }
    try {
      const protocol = getRuntimeProtocol(adapter, sessionId);
      return json(res, {
        sessionId: protocol.sessionId,
        capabilities: protocolCapabilityDescriptors(adapter),
        protocol,
        validation: protocol.validation || null,
        storageDiagnostic: adapter.getStorageDiagnostic?.() || null
      });
    } catch (error) {
      return runtimeError(res, error);
    }
  });

  // Bounded, provider-neutral Runtime Workbench projections. The browser
  // receives normalized facts and never interprets providerData.
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/runtime\/summary$/, async (_req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const sessionId = safeDecodeId(match[2]);
    const adapter = providerMap.get(providerId);
    if (!adapter) {
      const missing = missingProviderResponse(providerId);
      return json(res, missing.body, missing.status);
    }
    if (!sessionId) return json(res, { ok: false, error: "Invalid session id" }, 404);
    try {
      const protocol = getRuntimeProtocol(adapter, sessionId);
      return json(res, {
        summary: summarizeRuntimeProtocol(protocol, adapter.protocolCapabilities),
        storageDiagnostic: adapter.getStorageDiagnostic?.() || null
      });
    } catch (error) {
      return runtimeError(res, error);
    }
  });

  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/runtime\/events$/, async (req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const sessionId = safeDecodeId(match[2]);
    const adapter = providerMap.get(providerId);
    if (!adapter) {
      const missing = missingProviderResponse(providerId);
      return json(res, missing.body, missing.status);
    }
    if (!sessionId) return json(res, { ok: false, error: "Invalid session id" }, 404);
    try {
      const params = new URL(req.url || "/", `http://localhost:${appConfig.port}`).searchParams;
      const protocol = getRuntimeProtocol(adapter, sessionId);
      return json(res, queryRuntimeEvents(protocol, {
        cursor: params.get("cursor"),
        limit: params.get("limit"),
        categories: listParam(params, "category"),
        kinds: listParam(params, "kind"),
        phases: listParam(params, "phase"),
        taskId: params.get("taskId"),
        runId: params.get("runId"),
        correlationId: params.get("correlationId")
      }));
    } catch (error) {
      return runtimeError(res, error);
    }
  });

  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/runtime\/graph$/, async (req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const sessionId = safeDecodeId(match[2]);
    const adapter = providerMap.get(providerId);
    if (!adapter) {
      const missing = missingProviderResponse(providerId);
      return json(res, missing.body, missing.status);
    }
    if (!sessionId) return json(res, { ok: false, error: "Invalid session id" }, 404);
    try {
      const params = new URL(req.url || "/", `http://localhost:${appConfig.port}`).searchParams;
      const protocol = getRuntimeProtocol(adapter, sessionId);
      return json(res, buildRuntimeGraph(adapter, protocol, {
        depth: params.get("depth"),
        maxNodes: params.get("maxNodes")
      }));
    } catch (error) {
      return runtimeError(res, error);
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
      if (supportsSessionTrace(adapter)) {
        return json(res, adapter.getTrace(sessionId));
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

  // API: evidence-backed system prompt sources. This is deliberately separate
  // from transcript retrieval: adapters only return locally resolvable sources
  // and never claim to recover a provider-hidden prompt.
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/system-prompts$/, async (_req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const sessionId = decodeURIComponent(match[2]);
    const adapter = providerMap.get(providerId);
    if (!adapter) {
      const missing = missingProviderResponse(providerId);
      return json(res, missing.body, missing.status);
    }
    if (!supportsSystemPromptEvidence(adapter)) {
      return json(res, {
        sessionId,
        hiddenPromptStored: false,
        note: "This provider has no locally resolvable system prompt evidence.",
        sections: []
      });
    }
    try {
      const prompts = adapter.getSystemPrompts?.(sessionId);
      if (!prompts) {
        return json(res, { ok: false, error: "Not found" }, 404);
      }
      return json(res, prompts);
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      return json(res, { error: "Internal server error" }, 500);
    }
  });
}
