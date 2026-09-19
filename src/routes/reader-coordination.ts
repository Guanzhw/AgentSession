import { createHash } from "node:crypto";
import { getRuntimeProtocolV3, ProtocolRuntimeError } from "../protocol-runtime.js";
import { json, missingProviderResponse, safeDecodeId } from "../server-helpers.js";
import { getSessionDocument } from "../session-queries.js";
import { createReaderNativeSourceResolver } from "../reader-relations.js";
import {
  deriveReaderCoordinationPage,
  readerEventEvidence
} from "../reader-coordination.js";
import type { ReaderEventEvidence } from "../reader-coordination.js";
import { questionAnswersText } from "../providers/shared/question-answers.js";
import type { QuestionAnswer, ReaderCoordinationContent } from "../providers/interface.js";
import { renderReaderCoordinationPage, renderReaderCoordinationContentPage, renderReaderEventEvidence } from "../views/reader-coordination.js";
import { anchorId } from "../views/anchors.js";
import type { ProviderRouteDeps } from "./route-deps.js";

function runtimeError(res: any, error: unknown) {
  if (error instanceof ProtocolRuntimeError) {
    const status = error.code === "invalid_input" ? 400 : error.code === "protocol_invalid" ? 422 : 404;
    return json(res, { ok: false, error: error.message, code: error.code }, status);
  }
  console.error(`Reader coordination route error: ${error instanceof Error ? error.message : String(error)}`);
  return json(res, { ok: false, error: "Internal server error" }, 500);
}

function rootTreeHasPart(tree: any, partId: string): boolean {
  if (!tree) return true;
  return (tree.messages || []).some((message: any) => (message.parts || []).some((part: any) => String(part.id || "") === partId));
}

interface ReaderCoordinationDocument {
  messages: Array<{ id: string; data: { contentScope?: string } }>;
  partsByMessage: Map<string, Array<{
    id: string;
    contentScope?: string;
    data: { type: string; text?: string; questionAnswers?: QuestionAnswer[] };
  }>>;
}

/** Resolve only the event's exact normalized text; envelope and tool semantics belong to adapters. */
export function readerCoordinationDocumentContent(
  document: ReaderCoordinationDocument,
  event: Pick<ReaderEventEvidence, "messageId" | "partId" | "toolCallId" | "normalizedKind">
): ReaderCoordinationContent | null {
  const selected = createReaderNativeSourceResolver(document)(event);
  if (!selected) return null;
  const message = document.messages.find((candidate) => candidate.id === selected.position.messageId);
  if (!message) return null;
  const parts = document.partsByMessage.get(message.id) || [];
  const sourceParts = !event.partId && event.messageId === message.id && !event.toolCallId
    ? parts : parts.filter((part) => part.id === selected.position.partId);
  const text = sourceParts.filter((part) => (part.contentScope || message.data.contentScope || "owned") === "owned" && part.data.type === "text")
    .map((part) => part.data.questionAnswers ? questionAnswersText(part.data.questionAnswers) : part.data.text || "")
    .filter((value) => value.trim()).join("\n\n");
  return text.trim() ? { text, format: "markdown" } : null;
}

export function registerReaderCoordinationRoutes(app: any, deps: ProviderRouteDeps): void {
  const { providerMap } = deps;
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/reader\/coordination\/([^/]+)\/content$/, async (req: any, res: any, match: RegExpMatchArray) => {
    const provider = match[1];
    const sessionId = safeDecodeId(match[2]);
    const observationId = safeDecodeId(match[3]);
    const adapter = providerMap.get(provider);
    if (!adapter) {
      const missing = missingProviderResponse(provider);
      return json(res, missing.body, missing.status);
    }
    const params = new URL(req.url || "/", "http://localhost").searchParams;
    const offset = Number(params.get("offset") || 0);
    const requestedRevision = params.get("revision");
    if (!sessionId || !observationId || !Number.isSafeInteger(offset) || offset < 0
      || (offset > 0 && !/^[0-9a-f]{64}$/.test(requestedRevision || ""))) {
      return json(res, { ok: false, error: "Invalid coordination content request", code: "invalid_input" }, 400);
    }
    try {
      const protocol = getRuntimeProtocolV3(adapter, sessionId);
      const observation = protocol.coordination.find((item) => item.id === observationId);
      if (!observation) return json(res, {
        ok: false, error: "This exchange is no longer available", code: offset > 0 ? "stale_content" : "observation_not_found"
      }, offset > 0 ? 409 : 404);
      const sourceRevision = adapter.getReaderCoordinationContentRevision?.(sessionId, observation);
      let content: ReaderCoordinationContent | null = null;
      if (adapter.getReaderCoordinationContent) {
        content = adapter.getReaderCoordinationContent(sessionId, observation);
      } else {
        const owner = observation.sourceEventRef?.session || { provider, sessionId };
        const eventId = observation.sourceEventRef?.eventId || observation.eventId;
        const ownerAdapter = providerMap.get(owner.provider);
        if (eventId && ownerAdapter) {
          const localOwner = owner.provider === provider && owner.sessionId === sessionId;
          const ownerSession = localOwner ? null : ownerAdapter.getSession(owner.sessionId);
          const ownerProtocol = localOwner ? protocol : ownerSession ? getRuntimeProtocolV3(ownerAdapter, owner.sessionId, ownerSession) : null;
          const evidence = ownerProtocol ? readerEventEvidence(ownerProtocol, eventId) : null;
          if (evidence && (evidence.partId || evidence.messageId)) {
            const document = getSessionDocument(ownerAdapter, owner.provider, owner.sessionId);
            if (document) content = readerCoordinationDocumentContent(document, evidence);
          }
        }
      }
      if (sourceRevision != null && adapter.getReaderCoordinationContentRevision(sessionId, observation) !== sourceRevision) {
        return json(res, { ok: false, error: "The source changed while reading this exchange; reload its content", code: "stale_content" }, 409);
      }
      const revision = content ? createHash("sha256").update(JSON.stringify([content.format, content.text]), "utf8").digest("hex") : null;
      if (offset > 0 && requestedRevision !== revision) {
        return json(res, { ok: false, error: "This exchange changed; reload its content", code: "stale_content" }, 409);
      }
      return json(res, {
        ok: true, provider, sessionId, observationId, revision,
        ...renderReaderCoordinationContentPage(content, offset)
      });
    } catch (error) {
      return runtimeError(res, error);
    }
  });

  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/reader\/coordination$/, async (req: any, res: any, match: RegExpMatchArray) => {
    const provider = match[1];
    const sessionId = safeDecodeId(match[2]);
    const adapter = providerMap.get(provider);
    if (!adapter) {
      const missing = missingProviderResponse(provider);
      return json(res, missing.body, missing.status);
    }
    if (!sessionId) return json(res, { ok: false, error: "Invalid session id", code: "invalid_input" }, 400);
    try {
      const params = new URL(req.url || "/", "http://localhost").searchParams;
      const parsedSize = params.get("size");
      const page = deriveReaderCoordinationPage(getRuntimeProtocolV3(adapter, sessionId), {
        provider,
        sessionId,
        taskId: params.get("taskId"),
        runId: params.get("runId"),
        anchor: params.get("anchor"),
        size: parsedSize === null ? undefined : Number(parsedSize),
        cursor: params.get("cursor")
      });
      if (!page.ok) return json(res, page, page.code === "anchor_not_found" ? 404 : page.code === "stale_cursor" ? 409 : 400);
      return json(res, { ...page, html: renderReaderCoordinationPage(page) });
    } catch (error) {
      return runtimeError(res, error);
    }
  });

  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/reader\/event\/([^/]+)$/, async (_req: any, res: any, match: RegExpMatchArray) => {
    const provider = match[1];
    const sessionId = safeDecodeId(match[2]);
    const eventId = safeDecodeId(match[3]);
    const adapter = providerMap.get(provider);
    if (!adapter) {
      const missing = missingProviderResponse(provider);
      return json(res, missing.body, missing.status);
    }
    if (!sessionId || !eventId) return json(res, { ok: false, error: "Invalid reader event reference", code: "invalid_input" }, 400);
    try {
      const protocol = getRuntimeProtocolV3(adapter, sessionId);
      const evidence = readerEventEvidence(protocol, eventId);
      if (!evidence) return json(res, { ok: false, error: "Reader source event not found", code: "event_not_found" }, 404);
      let nativeTarget: { anchor: string; messageId: string; partId: string } | null = null;
      if (evidence.partId || evidence.messageId || evidence.toolCallId) {
        const document = getSessionDocument(adapter, provider, sessionId);
        const selected = document ? createReaderNativeSourceResolver(document)(evidence) : null;
        const partId = selected?.position.partId;
        const ownedReader = typeof adapter.getOwnedReaderProjection === "function"
          ? adapter.getOwnedReaderProjection(sessionId, {
              tasks: protocol.tasks,
              agentRuns: protocol.agentRuns,
              relationships: protocol.relationships
            })
          : undefined;
        const tree = ownedReader === undefined ? adapter.getSessionTree?.(sessionId) : ownedReader?.rootTree || null;
        if (partId && rootTreeHasPart(tree, partId)) {
          nativeTarget = { anchor: anchorId("part", partId), messageId: selected.position.messageId, partId };
        }
      }
      return json(res, { ok: true, provider, sessionId, nativeTarget, evidence, html: nativeTarget ? "" : renderReaderEventEvidence(evidence) });
    } catch (error) {
      return runtimeError(res, error);
    }
  });
}
