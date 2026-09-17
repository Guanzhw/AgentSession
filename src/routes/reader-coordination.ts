import { getRuntimeProtocolV3, ProtocolRuntimeError } from "../protocol-runtime.js";
import { json, missingProviderResponse, safeDecodeId } from "../server-helpers.js";
import { getSessionDocument } from "../session-queries.js";
import { createReaderNativeSourceResolver } from "../reader-relations.js";
import {
  deriveReaderCoordinationPage,
  readerEventEvidence
} from "../reader-coordination.js";
import { renderReaderCoordinationPage, renderReaderEventEvidence } from "../views/reader-coordination.js";
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

export function registerReaderCoordinationRoutes(app: any, deps: ProviderRouteDeps): void {
  const { providerMap } = deps;
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
