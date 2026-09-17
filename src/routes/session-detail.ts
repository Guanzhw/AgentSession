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
import { renderSessionPage, renderSessionReaderPane, renderInheritedContextPage, renderSessionMetricsPanel } from "../views/session.js";
import type { SessionProtocol } from "../providers/shared/session-protocol.js";
import type { ContextChangeResult } from "../providers/interface.js";
import { decorateRuntimeTransformationEvidence, projectRuntimeLanePresentation, renderRuntimeEvents, renderRuntimeRunPage, renderRuntimeWorkbench } from "../views/runtime-workbench.js";
import { renderContextChangeResult, renderProgressiveContent, resolveProgressiveField, resolveProgressiveRenderFormat, stringifyProgressiveValue } from "../views/components.js";
import { providerRenderContext } from "./provider-context.js";
import { parseSessionNavigationContext } from "../navigation-context.js";
import { t } from "../i18n.js";
import {
  buildRuntimeGraph,
  collectConversationCompactions,
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
  projectRunActorBindings,
  projectWork,
  ProtocolProjectionError,
  queryRunPage
} from "../protocol-runtime-v3.js";
import type { ProjectionOptions, RunPage, V3Projection } from "../protocol-runtime-v3.js";
import type { SessionProtocolV3 } from "../providers/shared/session-protocol-v3.js";
import { deriveConversationView } from "../conversation-view-model.js";
import { deriveReaderRelations } from "../reader-relations.js";

export function registerSessionDetail(
  app: any,
  deps: {
    appConfig: any;
    providerMap: Map<string, any>;
    providerInfo: any[];
  }
) {
  const { appConfig, providerMap, providerInfo } = deps;

  const runtimeRenderData = (adapter: any, sessionId: string, session: Record<string, unknown>, runPageOptions: { cursor?: string | null; limit?: string | null } = {}) => {
    try {
      const protocol = getRuntimeProtocol(adapter, sessionId, session);
      let v3: SessionProtocolV3;
      try {
        v3 = getRuntimeProtocolV3(adapter, sessionId);
      } catch (error) {
        if (error instanceof TypeError) {
          throw new ProtocolRuntimeError("protocol_invalid", "Runtime protocol is invalid for this session.");
        }
        throw error;
      }
      const projectionOptions = { maxItems: 100 };
      let runPage: RunPage | null = null;
      let runPageError: { code: string; message: string } | null = null;
      try {
        runPage = queryRunPage(v3, runPageOptions);
      } catch (error) {
        if (error instanceof ProtocolProjectionError) {
          runPageError = { code: error.code, message: error.message };
        } else {
          throw error;
        }
      }
      const runActorBindings = runPage
        ? projectRunActorBindings(v3, runPage.runs.map(({ run }) => run.id))
        : null;
      return {
        protocol: protocol as SessionProtocol,
        v3,
        runCursor: runPageOptions.cursor || null,
        runPage,
        runPageError,
        runActorBindings,
        projections: {
          work: projectWork(v3, projectionOptions),
          execution: projectExecution(v3, projectionOptions),
          coordination: projectCoordination(v3, projectionOptions),
          context: projectContext(v3, projectionOptions)
        },
        summary: summarizeRuntimeProtocol(protocol, adapter.protocolCapabilities),
        eventNextCursor: queryRuntimeEvents(protocol, { limit: 50 }).nextCursor,
        storageDiagnostic: adapter.getStorageDiagnostic?.() || null
      };
    } catch (error) {
      return {
        protocol: null,
        v3: null,
        runCursor: runPageOptions.cursor || null,
        runPage: null,
        runPageError: null,
        runActorBindings: null,
        projections: null,
        summary: {
          version: 2,
          completeness: "partial",
          counts: { events: 0, relationships: 0, tasks: 0, agentRuns: 0, contextArtifacts: 0, branches: 0 },
          capabilities: {}
        },
        storageDiagnostic: adapter.getStorageDiagnostic?.() || null,
        runtimeError: {
          code: error instanceof ProtocolRuntimeError
            ? error.code
            : error instanceof ProtocolProjectionError
              ? error.code
            : "runtime_unavailable",
          message: error instanceof ProtocolRuntimeError
            ? "Runtime protocol is unavailable for this session."
            : error instanceof ProtocolProjectionError
              ? error.message
            : "Runtime protocol could not be loaded."
        }
      };
    }
  };

  // Shared preparation for the HTML shell and page-shell-free reader route.
  // Keeping the normalized tree, runtime compactions, inherited context and
  // conversation projection together makes both consumers render the same
  // reader input and keeps child loading on the existing provider boundary.
  const prepareReader = (adapter: any, providerId: string, sessionId: string, document: any, runPageOptions: { cursor?: string | null; limit?: string | null } = {}) => {
    const runtime = runtimeRenderData(adapter, sessionId, document.session, runPageOptions);
    const conversationView = runtime.v3 && runtime.projections
      ? deriveConversationView({
          protocol: runtime.v3,
          work: runtime.projections.work,
          execution: runtime.projections.execution,
          coordination: runtime.projections.coordination,
          context: runtime.projections.context
        })
      : null;
    const ownedReader = typeof adapter.getOwnedReaderProjection === "function"
      ? adapter.getOwnedReaderProjection(sessionId, runtime.v3 ? {
          tasks: runtime.v3.tasks,
          agentRuns: runtime.v3.agentRuns,
          relationships: runtime.v3.relationships
        } : undefined)
      : undefined;
    const readerInput = {
      session: document.session,
      sessionTree: ownedReader === undefined ? adapter.getSessionTree?.(sessionId) || null : null,
      ownedReader,
      messages: document.messages,
      partsByMessage: document.partsByMessage,
      provider: providerId,
      conversationCompactions: collectConversationCompactions(runtime.protocol),
      conversationView,
      readerRelations: runtime.v3 ? deriveReaderRelations(runtime.v3, document) : null,
      inheritedContext: adapter.getInheritedContext?.(sessionId) || null
    };
    return { runtime, readerPane: renderSessionReaderPane(readerInput) };
  };

  const runtimeError = (res: any, error: unknown, options: { protocolInvalid?: boolean } = {}) => {
    if (error instanceof ProtocolRuntimeError) {
      const status = error.code === "invalid_input" ? 400 : error.code === "protocol_invalid" ? 422 : 404;
      return json(res, { ok: false, error: error.message, code: error.code }, status);
    }
    if (options.protocolInvalid && error instanceof TypeError) {
      return json(res, { ok: false, error: "Runtime protocol is invalid for this session.", code: "protocol_invalid" }, 422);
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

  const contextResultFor = (adapter: any, sessionId: string, document: any, checkpointId: string): ContextChangeResult | null => {
    if (adapter.getContextChangeResult) return adapter.getContextChangeResult(sessionId, checkpointId);
    const compaction = collectConversationCompactions(getRuntimeProtocol(adapter, sessionId, document.session))
      .find((item) => item.id === checkpointId);
    if (!compaction) return null;
    return {
      checkpointId,
      source: {
        fidelity: compaction.fidelity === "recorded" ? "recorded" : "derived",
        sourceType: "protocol.context-checkpoint",
        sourceId: compaction.id,
        sourceOrdinal: null,
        sourceOrdinalProvenance: "source-order/derived"
      },
      summary: compaction.summary
        ? { value: compaction.summary, availability: "readable" }
        : { value: null, availability: "not-recorded" },
      groups: [],
      omitted: { encryptedFieldPaths: [], encryptedFieldCount: 0 }
    };
  };

  const searchSessionContent = (document: any, query: string, offset: number, limit: number) => {
    const normalizedQuery = query.toLocaleLowerCase();
    const matches: any[] = [];
    let total = 0;
    const fields = ["text", "reasoning", "input", "output"] as const;
    for (const message of document.messages || []) {
      const parts = document.partsByMessage?.get(message.id) || [];
      for (const part of parts) {
        if (part.contentScope && part.contentScope !== "owned") continue;
        for (const field of fields) {
          const resolved = resolveProgressiveField(part.data, field, "owned");
          if (!resolved) continue;
          const source = stringifyProgressiveValue(resolved.value);
          const searchable = source.toLocaleLowerCase();
          let fieldMatchIndex = 0;
          let matchOffset = searchable.indexOf(normalizedQuery);
          while (matchOffset >= 0) {
            if (total >= offset && matches.length < limit) {
              const excerptStart = Math.max(0, matchOffset - 96);
              const excerptEnd = Math.min(source.length, matchOffset + normalizedQuery.length + 96);
              matches.push({
                messageId: String(message.id || ""),
                partId: String(part.id || ""),
                field,
                contentScope: "owned",
                offset: matchOffset,
                matchIndex: fieldMatchIndex,
                matchLength: query.length,
                excerpt: source.slice(excerptStart, excerptEnd),
                excerptStart,
                totalLength: source.length,
                format: resolveProgressiveRenderFormat(resolved.value, resolved.format)
              });
            }
            total += 1;
            fieldMatchIndex += 1;
            matchOffset = searchable.indexOf(normalizedQuery, matchOffset + Math.max(1, normalizedQuery.length));
          }
        }
      }
    }
    return {
      matches,
      total,
      offset,
      limit,
      nextOffset: offset + matches.length < total ? offset + matches.length : null
    };
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
    const pageUrl = new URL(req.url || "/", `http://localhost:${appConfig.port}`);
    const navigationContext = parseSessionNavigationContext(pageUrl.searchParams.get("from"));

    try {
      const document = getSessionDocument(adapter, providerSegment, sessionId);
      if (!document) {
        return { status: 404, body: "<h1>Session not found</h1>", contentType: "text/html; charset=utf-8" };
      }

      const recentSessions = createSessionCatalog(adapter, providerSegment)
        .list({ limit: 30, offset: 0 }).sessions;
      const resumeCommand = getResumeCommand(adapter, sessionId, document.session.directory, appConfig.resumeCommands);
      const reader = prepareReader(adapter, providerSegment, sessionId, document, {
        cursor: pageUrl.searchParams.get("runCursor"),
        limit: pageUrl.searchParams.get("runLimit")
      });
      return {
        status: 200,
        body: renderSessionPage({
          session: document.session,
          sessionMetrics: typeof adapter.getOwnedReaderProjection === "function" ? null : adapter.getSessionMetrics?.(sessionId) || null,
          lazySessionMetrics: typeof adapter.getOwnedReaderProjection === "function"
            ? { provider: providerSegment, sessionId }
            : null,
          todos: document.todos,
          recentSessions,
          meta: document.meta,
          resumeCommand,
          runtimeWorkbench: renderRuntimeWorkbench(reader.runtime, providerSegment, sessionId),
          runtimeEvents: renderRuntimeEvents(reader.runtime, providerSegment, sessionId),
          readerPane: reader.readerPane,
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

  // API: page-shell-free reader pane. This is the exact fragment used by the
  // detail route, allowing the browser to load child histories on demand
  // without creating a second transcript projection.
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/reader$/, async (_req: any, res: any, match: RegExpMatchArray) => {
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

    try {
      const document = getSessionDocument(adapter, providerId, sessionId);
      if (!document) {
        return json(res, { ok: false, error: "Not found" }, 404);
      }
      const reader = prepareReader(adapter, providerId, sessionId, document);
      const title = document.session.title || document.session.slug || document.session.id;
      return json(res, { ok: true, provider: providerId, sessionId, title, html: reader.readerPane });
    } catch (err: any) {
      console.error(`Reader route error: ${err.message}`);
      return json(res, { ok: false, error: "Internal server error" }, 500);
    }
  });

  // Lazy family totals used by the closed Work disclosure. Optimized
  // providers retain their inclusive semantics behind this explicit request.
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/reader\/work-metrics$/, async (_req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const sessionId = safeDecodeId(match[2]);
    const adapter = providerMap.get(providerId);
    if (!adapter) {
      const missing = missingProviderResponse(providerId);
      return json(res, missing.body, missing.status);
    }
    if (!sessionId) return json(res, { ok: false, error: "Invalid session id" }, 404);
    try {
      const document = getSessionDocument(adapter, providerId, sessionId);
      if (!document) return json(res, { ok: false, error: "Not found" }, 404);
      const metrics = adapter.getSessionMetrics?.(sessionId) || null;
      if (!metrics) return json(res, { ok: false, error: "Session metrics unavailable", code: "metrics_unavailable" }, 422);
      return json(res, { ok: true, provider: providerId, sessionId, metrics, html: renderSessionMetricsPanel(metrics) });
    } catch (err: any) {
      console.error(`Reader metrics route error: ${err.message}`);
      return json(res, { ok: false, error: "Session metrics unavailable", code: "metrics_unavailable" }, 422);
    }
  });

  // Lazy child preview and token disclosure. Only the selected child is read;
  // its full history remains the existing /reader navigation boundary.
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/reader\/child\/([^/]+)$/, async (_req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const parentId = safeDecodeId(match[2]);
    const childId = safeDecodeId(match[3]);
    const adapter = providerMap.get(providerId);
    if (!adapter) {
      const missing = missingProviderResponse(providerId);
      return json(res, missing.body, missing.status);
    }
    if (!parentId || !childId) return json(res, { ok: false, error: "Invalid reader child reference", code: "invalid_input" }, 400);
    try {
      const parent = adapter.getSession(parentId) as any;
      const child = adapter.getSession(childId) as any;
      if (!parent || !child || String(child.parentId || child.parent_id || "") !== String(parent.id)) {
        return json(res, { ok: false, error: "Reader child not found", code: "child_not_found" }, 404);
      }
      const document = getSessionDocument(adapter, providerId, childId);
      if (!document) return json(res, { ok: false, error: "Reader child not found", code: "child_not_found" }, 404);
      let preview: { partId: string; text: string; final: boolean } | null = null;
      for (let index = document.messages.length - 1; index >= 0; index -= 1) {
        const message = document.messages[index];
        if (message.data?.role !== "assistant" && message.data?.role !== "agent") continue;
        const parts = document.partsByMessage?.get(message.id) || [];
        const part = parts.find((candidate: any) => (!candidate.contentScope || candidate.contentScope === "owned") && candidate.data?.type === "text" && typeof candidate.data.text === "string" && candidate.data.text.trim());
        if (!part) continue;
        const text = String(part.data.text).trim();
        const candidate = { partId: String(part.id), text: text.length > 240 ? `${text.slice(0, 239)}…` : text, final: message.data?.presentationPhase === "final" };
        if (candidate.final) {
          preview = candidate;
          break;
        }
        preview ??= candidate;
      }
      return json(res, { ok: true, provider: providerId, parentSessionId: parentId, sessionId: childId, preview, metrics: adapter.getSessionMetrics?.(childId) || null });
    } catch (err: any) {
      console.error(`Reader child route error: ${err.message}`);
      return json(res, { ok: false, error: "Reader child unavailable", code: "child_unavailable" }, 422);
    }
  });

  // Inherited records remain separate from owned reading/search, including
  // when the referenced parent file is no longer available.
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/inherited-context$/, async (req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const sessionId = safeDecodeId(match[2]);
    const adapter = providerMap.get(providerId);
    if (!adapter) {
      const missing = missingProviderResponse(providerId);
      return json(res, missing.body, missing.status);
    }
    if (!sessionId) return json(res, { ok: false, error: "Invalid session id" }, 404);
    const offset = Number(new URL(req.url || "/", `http://localhost:${appConfig.port}`).searchParams.get("offset") || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) return json(res, { ok: false, error: "Invalid inherited context offset" }, 400);
    try {
      const inherited = adapter.getInheritedContext?.(sessionId);
      if (!inherited) return json(res, { ok: false, error: "Inherited context not found" }, 404);
      const page = renderInheritedContextPage(inherited, providerId, offset);
      return json(res, { ok: true, provider: providerId, sessionId, scope: "inherited-context", ...page });
    } catch (err: any) {
      console.error(`Inherited context route error: ${err.message}`);
      return json(res, { ok: false, error: "Internal server error" }, 500);
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

  // API: one bounded page of a normalized recorded context-change result.
  // The provider accessor is deliberately called only from this on-demand
  // route; ordinary reader and graph preparation stay metadata-only.
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/context-result$/, async (req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const sessionId = safeDecodeId(match[2]);
    const adapter = providerMap.get(providerId);
    if (!adapter) {
      const missing = missingProviderResponse(providerId);
      return json(res, missing.body, missing.status);
    }
    if (!sessionId) return json(res, { ok: false, error: "Invalid session id" }, 404);
    const params = new URL(req.url || "/", `http://localhost:${appConfig.port}`).searchParams;
    const checkpointId = params.get("checkpoint") || "";
    const offset = Number(params.get("offset") || 0);
    const limit = Number(params.get("limit") || 20);
    if (!checkpointId || checkpointId.length > 200 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      return json(res, { ok: false, error: "Invalid context result request" }, 400);
    }
    try {
      const document = getSessionDocument(adapter, providerId, sessionId);
      if (!document) return json(res, { ok: false, error: "Not found" }, 404);
      const result = contextResultFor(adapter, sessionId, document, checkpointId);
      if (!result) return json(res, { ok: false, error: "Context checkpoint not found" }, 404);
      const page = renderContextChangeResult(result, { provider: providerId, sessionId }, offset, limit);
      return json(res, {
        ok: true,
        provider: providerId,
        sessionId,
        checkpointId,
        scope: "context-result",
        offset,
        limit,
        nextOffset: page.nextOffset,
        totalEntries: page.totalEntries,
        availability: result.summary.availability,
        html: page.html
      });
    } catch (err: any) {
      if (err instanceof ProtocolRuntimeError) return runtimeError(res, err);
      console.error(`Context result route error: ${err.message}`);
      return json(res, { ok: false, error: "Internal server error" }, 500);
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
    const contentScope = params.get("scope") || "owned";
    const offset = Number(params.get("offset") || 0);
    const checkpointId = params.get("checkpoint") || "";
    const contextTarget = params.get("target") || "";
    const contextGroup = Number(params.get("group") || "-1");
    const contextEntry = Number(params.get("entry") || "-1");
    const standardRequest = Boolean(partId) && ["owned", "inherited-context"].includes(contentScope) && ["text", "reasoning", "input", "output"].includes(String(field));
    const contextRequest = contentScope === "context-result"
      && Boolean(checkpointId)
      && ((contextTarget === "summary" && field === "summary" && contextGroup === -1 && contextEntry === -1)
        || (contextTarget === "entry" && field === "content" && Number.isSafeInteger(contextGroup) && contextGroup >= 0 && Number.isSafeInteger(contextEntry) && contextEntry >= 0));
    if ((!standardRequest && !contextRequest) || !Number.isSafeInteger(offset) || offset < 0) {
      return json(res, { ok: false, error: "Invalid content request" }, 400);
    }

    try {
      if (contextRequest) {
        const document = getSessionDocument(adapter, providerId, sessionId);
        if (!document) return json(res, { ok: false, error: "Not found" }, 404);
        const result = contextResultFor(adapter, sessionId, document, checkpointId);
        if (!result) return json(res, { ok: false, error: "Context checkpoint not found" }, 404);
        const value = contextTarget === "summary"
          ? result.summary.value
          : result.groups[contextGroup]?.entries[contextEntry]?.content;
        if (value == null || (contextTarget === "summary" && result.summary.availability !== "readable")) {
          return json(res, { ok: false, error: "Context result content unavailable", code: "content_unavailable" }, 404);
        }
        const page = renderProgressiveContent(value, "plain", offset, 6000);
        return json(res, { ok: true, scope: "context-result", provider: providerId, sessionId, checkpointId, target: contextTarget, group: contextGroup, entry: contextEntry, field, ...page });
      }
      let part = null;
      if (contentScope === "owned") {
        const document = getSessionDocument(adapter, providerId, sessionId);
        if (!document) return json(res, { ok: false, error: "Not found" }, 404);
        part = [...(document.partsByMessage?.values?.() || [])].flat().find((candidate: any) => String(candidate.id) === partId) || null;
      }
      if (!part && contentScope === "inherited-context") {
        const inherited = adapter.getInheritedContext?.(sessionId);
        if (inherited) {
          const raw = buildPartsFromProviderMessages(
            inherited.messages,
            `inherited-${inherited.sourceSession.sessionId}-`,
            "inherited-context"
          );
          part = [...raw.partsByMessage.values()].flat().find((candidate: any) => String(candidate.id) === partId) || null;
        }
      }
      const data = part?.data && typeof part.data === "object" ? part.data : null;
      if (!data) {
        return json(res, { ok: false, error: "Content not found" }, 404);
      }

      const resolved = resolveProgressiveField(data, field as "text" | "reasoning" | "input" | "output", contentScope, part.messageRole || "");
      if (!resolved) {
        return json(res, { ok: false, error: "Content not found" }, 404);
      }
      const page = renderProgressiveContent(resolved.value, resolved.format, offset, resolved.limit);
      return json(res, { ok: true, ...page });
    } catch (err: any) {
      if (err instanceof ProtocolRuntimeError) return runtimeError(res, err);
      console.error(`Route error: ${err.message}`);
      return json(res, { error: "Internal server error" }, 500);
    }
  });

  // API: complete owned-content search for the active canonical reader pane.
  // Search uses the same direct normalized parts and field formatting as the
  // continuation route, while keeping the initial HTML bounded.
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/search$/, async (req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const sessionId = safeDecodeId(match[2]);
    const adapter = providerMap.get(providerId);
    if (!adapter) {
      const missing = missingProviderResponse(providerId);
      return json(res, missing.body, missing.status);
    }
    if (!sessionId) return json(res, { ok: false, error: "Invalid session id" }, 404);
    const params = new URL(req.url || "/", `http://localhost:${appConfig.port}`).searchParams;
    const query = (params.get("q") ?? params.get("query") ?? "").trim();
    const offset = Number(params.get("offset") || 0);
    const limit = Number(params.get("limit") || 50);
    if (!query || query.length > 2000 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return json(res, { ok: false, error: "Invalid search request" }, 400);
    }
    try {
      const document = getSessionDocument(adapter, providerId, sessionId);
      if (!document) return json(res, { ok: false, error: "Not found" }, 404);
      const page = searchSessionContent(document, query, offset, limit);
      return json(res, {
        ok: true,
        provider: providerId,
        sessionId,
        query,
        scope: "owned",
        coverage: "complete-owned-content",
        ...page
      });
    } catch (err: any) {
      console.error(`Search route error: ${err.message}`);
      return json(res, { ok: false, error: "Internal server error" }, 500);
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

  // Run-only browsing uses the finalized run collection and its own bound;
  // actor, usage, and conversation projections remain unchanged.
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/runtime\/execution\/runs$/, async (req: any, res: any, match: RegExpMatchArray) => {
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
      const protocolV3 = getRuntimeProtocolV3(adapter, sessionId);
      const page = queryRunPage(protocolV3, {
        cursor: params.get("cursor"),
        limit: params.get("limit")
      });
      const actorBindings = projectRunActorBindings(protocolV3, page.runs.map(({ run }) => run.id));
      const actorLabels = new Map<string, string>();
      actorBindings.actors.forEach((entry) => {
        const actorId = (entry.ref as { id?: string }).id;
        if (actorId) actorLabels.set(actorId, entry.actor.name || (entry.actor.kind === "team" ? t("runtime.team") : t("runtime.agent")));
      });
      const lanePresentation = projectRuntimeLanePresentation(protocolV3, page.runs);
      return json(res, {
        ok: true,
        ...page,
        html: renderRuntimeRunPage(page, actorBindings.actorByRun, actorLabels, lanePresentation, { runCursor: params.get("cursor") }),
        evidenceRuns: page.runs.map((entry) => entry.run),
        pageCoordination: lanePresentation.coordination,
        pageTransformations: (lanePresentation.transformations || []).map((transformation) => decorateRuntimeTransformationEvidence(protocolV3, transformation)),
        pageVersions: lanePresentation.versions,
        pageArtifacts: lanePresentation.artifacts
      });
    } catch (error) {
      if (error instanceof ProtocolProjectionError) {
        return json(res, { ok: false, error: error.message, code: error.code }, 400);
      }
      return runtimeError(res, error, { protocolInvalid: true });
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
        return runtimeError(res, error, { protocolInvalid: true });
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
