import {
  buildPartsFromProviderMessages,
  createSessionCatalog,
  getSessionDocument
} from "../session-queries.js";
import {
  json,
  safeDecodeId,
  missingProviderResponse
} from "../server-helpers.js";
import {
  supportsSessionProtocol,
  protocolCapabilityDescriptors,
  supportsSystemPromptEvidence,
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
  getRuntimeProtocolV3,
  ProtocolRuntimeError,
  queryRuntimeEvents,
  summarizeRuntimeProtocol
} from "../protocol-runtime.js";
import {
  projectContext,
  projectCoordination,
  projectExecution,
  projectWork,
  ProtocolProjectionError
} from "../protocol-runtime-v3.js";
import type { ProjectionOptions, V3Projection } from "../protocol-runtime-v3.js";
import type { SessionProtocolV3 } from "../providers/shared/session-protocol-v3.js";

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
      const status = error.code === "invalid_input" ? 400 : error.code === "protocol_invalid" ? 422 : 404;
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
      const document = getSessionDocument(adapter, providerSegment, sessionId);
      if (!document) {
        return { status: 404, body: "<h1>Session not found</h1>", contentType: "text/html; charset=utf-8" };
      }

      const recentSessions = createSessionCatalog(adapter, providerSegment)
        .list({ limit: 30, offset: 0 }).sessions;
      const resumeCommand = getResumeCommand(adapter, sessionId, document.session.directory, appConfig.resumeCommands);
      const runtime = runtimeRenderData(adapter, sessionId, document.session);
      return {
        status: 200,
        body: renderSessionPage({
          session: document.session,
          sessionTree: adapter.getSessionTree?.(sessionId) || null,
          sessionMetrics: adapter.getSessionMetrics?.(sessionId) || null,
          messages: document.messages,
          partsByMessage: document.partsByMessage,
          todos: document.todos,
          recentSessions,
          meta: document.meta,
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
      const document = getSessionDocument(adapter, providerId, sessionId);
      if (!document) {
        return json(res, { ok: false, error: "Not found" }, 404);
      }

      return json(res, {
        session: document.apiSession,
        tree: adapter.getSessionTree?.(sessionId) || null,
        container: adapter.getSessionContainer?.(sessionId) || null,
        metrics: adapter.getSessionMetrics?.(sessionId) || null,
        messages: document.apiMessages
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
      const document = getSessionDocument(adapter, providerId, id);
      if (!document) {
        return json(res, { ok: false, error: "Not found" }, 404);
      }
      const session = document.exportSession;
      const messages = document.messages;
      const { partsByMessage } = document;

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
          messages: document.exportMessages
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

  // v3 Work Graph domains are explicit typed projections. A v2 protocol is
  // upgraded at this boundary, preserving v2 facts while leaving unsupported
  // v3 evidence unknown. These routes never expose provider-private fields.
  const v3ProjectionRoute = (project: (protocol: SessionProtocolV3, options: ProjectionOptions) => V3Projection) => (
    async (req: any, res: any, match: RegExpMatchArray) => {
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
        const projection = project(getRuntimeProtocolV3(adapter, sessionId), { maxItems: params.get("maxItems") });
        return json(res, projection);
      } catch (error) {
        if (error instanceof ProtocolProjectionError) {
          return json(res, { ok: false, error: error.message, code: error.code }, 400);
        }
        return runtimeError(res, error);
      }
    }
  );

  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/runtime\/work$/, v3ProjectionRoute(projectWork));
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/runtime\/execution$/, v3ProjectionRoute(projectExecution));
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/runtime\/coordination$/, v3ProjectionRoute(projectCoordination));
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/runtime\/context$/, v3ProjectionRoute(projectContext));

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
