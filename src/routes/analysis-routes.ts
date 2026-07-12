import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  buildAnalysisPromptPreview,
  launchAnalysisImplementation,
  launchSessionAnalysis,
  listSessionAnalysisRuns,
  prepareAnalysisImplementation,
  prepareSessionAnalysis,
  findActiveSessionAnalysisRun,
  getSessionAnalysisAction
} from "../analysis.js";
import {
  json,
  readBody,
  safeDecodeId,
  isTrustedLocalJsonRequest
} from "../server-helpers.js";
import { validateUserConfig } from "../config.js";
import { getProvider } from "../providers/index.js";
import { supportsSessionAnalysis } from "../providers/kinds.js";
import {
  recordRuntimeEvent,
  runtimeErrorMessage,
  runtimeExecutableName
} from "../runtime-log.js";

export function registerAnalysisRoutes(
  app: any,
  deps: {
    appConfig: any;
    providerMap: Map<string, any>;
  }
) {
  const { appConfig, providerMap } = deps;

  // Prompt preview
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/analysis\/prompt-preview$/, async (req: any, res: any, match: RegExpMatchArray) => {
    const provider = getProvider(match[1]);
    if (!provider) {
      return json(res, { ok: false, error: "Provider not found" }, 404);
    }
    try {
      let analysisConfig = appConfig.analysis;
      let targetId = "";
      const url = new URL(req.url || "/", `http://localhost:${appConfig.port}`);
      targetId = url.searchParams.get("target") || "";
      const preview = buildAnalysisPromptPreview({
        provider,
        analysisConfig,
        configPath: appConfig.configPath,
        targetId
      });
      return json(res, { ok: true, preview });
    } catch (error: any) {
      return json(res, {
        ok: false,
        error: error?.message || "Failed to build analyzer prompt preview"
      }, 409);
    }
  });

  app.post(/^\/api\/([a-z][a-z0-9-]*)\/analysis\/prompt-preview$/, async (req: any, res: any, match: RegExpMatchArray) => {
    const provider = getProvider(match[1]);
    if (!provider) {
      return json(res, { ok: false, error: "Provider not found" }, 404);
    }
    try {
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
      const analysisConfig = body.config.analysis;
      const targetId = typeof body.target === "string" ? body.target : "";
      const preview = buildAnalysisPromptPreview({
        provider,
        analysisConfig,
        configPath: appConfig.configPath,
        targetId
      });
      return json(res, { ok: true, preview });
    } catch (error: any) {
      return json(res, {
        ok: false,
        error: error?.message || "Failed to build analyzer prompt preview"
      }, 409);
    }
  });

  // Analyze session
  app.post(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/analyze$/, async (req: any, res: any, match: RegExpMatchArray) => {
    if (!isTrustedLocalJsonRequest(req)) {
      return json(res, { ok: false, error: "Analysis requests must be same-origin JSON from loopback" }, 403);
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
    if (!supportsSessionAnalysis(adapter)) {
      return json(res, { ok: false, error: "Session analysis is not supported for this provider" }, 501);
    }
    const session = adapter.getSession(sessionId);
    if (!session) {
      return json(res, { ok: false, error: "Session not found" }, 404);
    }

    let analysisPhase = "prepare";
    let analysisTargetId = "";
    let preparedAnalysisRun: any = null;
    try {
      const body = await readBody(req);
      const action = getSessionAnalysisAction(
        adapter,
        sessionId,
        session.directory,
        appConfig.analysis
      );
      if (!action) {
        return json(res, { ok: false, error: "Session analysis is not configured" }, 400);
      }
      const actionTargets = new Map((action?.targets || []).map((target: any) => [target.id, target]));
      const requestedTarget = typeof body.target === "string"
        ? body.target.trim()
        : Array.isArray(body.targets)
          ? String(body.targets.find((target: any) => typeof target === "string") || "").trim()
          : "";
      const runtimeExtensionIds = Array.isArray(body.runtimeExtensionIds)
        ? body.runtimeExtensionIds
          .filter((id: any) => typeof id === "string")
          .map((id: string) => id.trim())
          .filter(Boolean)
        : null;
      analysisTargetId = requestedTarget || action.target;
      const selectedTarget = actionTargets.get(analysisTargetId);
      if (!selectedTarget) {
        return json(res, { ok: false, error: `Analysis target is unavailable: ${analysisTargetId}` }, 400);
      }
      if (!selectedTarget.available) {
        return json(res, {
          ok: false,
          error: "Configured analysis executable was not found",
          target: analysisTargetId
        }, 409);
      }
      const activeRun = findActiveSessionAnalysisRun({
        provider: adapter,
        providerId,
        sessionId,
        directory: session.directory,
        analysisConfig: appConfig.analysis,
        metaDir: appConfig.metaDir,
        targetId: analysisTargetId
      });
      if (activeRun) {
        return json(res, {
          ok: false,
          error: `Analysis is already running for target: ${analysisTargetId}`,
          target: analysisTargetId,
          activeRun: {
            runId: activeRun.runId,
            runDir: activeRun.runDir,
            target: activeRun.target,
            state: activeRun.state
          }
        }, 409);
      }
      const run = prepareSessionAnalysis({
        provider: adapter,
        sessionId,
        analysisConfig: appConfig.analysis,
        metaDir: appConfig.metaDir,
        configPath: appConfig.configPath,
        targetId: analysisTargetId,
        runtimeExtensionIds
      });
      preparedAnalysisRun = run;
      recordRuntimeEvent(appConfig.metaDir, {
        event: "analysis.prepare",
        provider: providerId,
        sessionId,
        runId: run.runId,
        target: run.target,
        runtimeExtensionCount: runtimeExtensionIds?.length ?? null,
        runDir: run.runDir,
        ok: true
      });
      analysisPhase = "launch";
      const launchResult = await launchSessionAnalysis(run, appConfig.resumeShell);
      recordRuntimeEvent(appConfig.metaDir, {
        event: "analysis.launch",
        provider: providerId,
        sessionId,
        runId: run.runId,
        target: run.target,
        executable: runtimeExecutableName(run.command),
        cwd: run.command?.cwd,
        launchPid: launchResult?.pid ?? null,
        launchHost: launchResult?.usedTerminal ? "terminal" : "powershell",
        fallbackFrom: (launchResult as any)?.fallbackFrom,
        ok: true
      });
      return json(res, {
        ok: true,
        runId: run.runId,
        runDir: run.runDir,
        target: run.target,
        targets: [run.target],
        runs: [{
          runId: run.runId,
          runDir: run.runDir,
          target: run.target
        }]
      });
    } catch (error: any) {
      console.error("Session analysis launch error:", error?.message || error);
      recordRuntimeEvent(appConfig.metaDir, {
        event: analysisPhase === "launch" ? "analysis.launch" : "analysis.prepare",
        level: "error",
        provider: match[1],
        sessionId: safeDecodeId(match[2]),
        runId: preparedAnalysisRun?.runId,
        target: preparedAnalysisRun?.target || analysisTargetId || undefined,
        ok: false,
        error: runtimeErrorMessage(error)
      });
      return json(res, { ok: false, error: error?.message || "Failed to launch session analysis" }, 500);
    }
  });

  // Analysis implementation
  app.post(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/analyses\/([^/]+)\/implement$/, async (req: any, res: any, match: RegExpMatchArray) => {
    if (!isTrustedLocalJsonRequest(req)) {
      return json(res, { ok: false, error: "Implementation requests must be same-origin JSON from loopback" }, 403);
    }
    if (!appConfig.allowTerminalLaunch) {
      return json(res, { ok: false, error: "Terminal launch is disabled" }, 403);
    }

    const providerId = match[1];
    const sessionId = safeDecodeId(match[2]);
    const runId = safeDecodeId(match[3]);
    const adapter = providerMap.get(providerId);
    if (!sessionId || !runId || !adapter) {
      return json(res, { ok: false, error: "Analysis run not found" }, 404);
    }
    if (!supportsSessionAnalysis(adapter)) {
      return json(res, { ok: false, error: "Analysis implementation is not supported for this provider" }, 501);
    }
    const session = adapter.getSession(sessionId);
    if (!session) {
      return json(res, { ok: false, error: "Session not found" }, 404);
    }

    let implementationPhase = "prepare";
    let preparedImplementationRun: any = null;
    try {
      await readBody(req);
      const run = prepareAnalysisImplementation({
        provider: adapter,
        sessionId,
        analysisConfig: appConfig.analysis,
        metaDir: appConfig.metaDir,
        runId
      });
      preparedImplementationRun = run;
      recordRuntimeEvent(appConfig.metaDir, {
        event: "analysis.implementation.prepare",
        provider: providerId,
        sessionId,
        runId: run.runId,
        runDir: run.runDir,
        ok: true
      });
      implementationPhase = "launch";
      const launchResult = await launchAnalysisImplementation(run, appConfig.resumeShell);
      recordRuntimeEvent(appConfig.metaDir, {
        event: "analysis.implementation.launch",
        provider: providerId,
        sessionId,
        runId: run.runId,
        executable: runtimeExecutableName(run.command),
        cwd: run.command?.cwd,
        launchPid: launchResult?.pid ?? null,
        launchHost: launchResult?.usedTerminal ? "terminal" : "powershell",
        fallbackFrom: (launchResult as any)?.fallbackFrom,
        ok: true
      });
      return json(res, {
        ok: true,
        runId: run.runId,
        runDir: run.runDir
      });
    } catch (error: any) {
      console.error("Analysis implementation launch error:", error?.message || error);
      recordRuntimeEvent(appConfig.metaDir, {
        event: implementationPhase === "launch"
          ? "analysis.implementation.launch"
          : "analysis.implementation.prepare",
        level: "error",
        provider: providerId,
        sessionId,
        runId: preparedImplementationRun?.runId || runId,
        ok: false,
        error: runtimeErrorMessage(error)
      });
      return json(res, { ok: false, error: error?.message || "Failed to launch analysis implementation" }, 500);
    }
  });

  // Analysis diagnostics
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/analyses\/([^/]+)\/diagnostics\/(stdout|stderr)$/, (req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const sessionId = safeDecodeId(match[2]);
    const runId = safeDecodeId(match[3]);
    const diagnosticId = match[4];
    const adapter = providerMap.get(providerId);
    if (!sessionId || !runId || !adapter) {
      return json(res, { ok: false, error: "Analysis diagnostic not found" }, 404);
    }
    try {
      const session = adapter.getSession(sessionId);
      if (!session) {
        return json(res, { ok: false, error: "Analysis diagnostic not found" }, 404);
      }
      const runs = listSessionAnalysisRuns({
        provider: adapter,
        providerId,
        sessionId,
        directory: session.directory,
        analysisConfig: appConfig.analysis,
        metaDir: appConfig.metaDir,
        limit: 50
      });
      const run = runs.find((item: any) => item.runId === runId);
      const diagnostic = (run?.diagnostics as Record<string, any> | undefined)?.[diagnosticId];
      if (!run || !diagnostic?.available) {
        return json(res, { ok: false, error: "Analysis diagnostic not found" }, 404);
      }
      const resolvedRunDir = path.resolve(run.runDir);
      const diagnosticPath = path.resolve(run.runDir, diagnostic.relativePath || diagnostic.fileName);
      if (!diagnosticPath.startsWith(`${resolvedRunDir}${path.sep}`)) {
        return json(res, { ok: false, error: "Analysis diagnostic not found" }, 404);
      }
      const diagnosticStat = lstatSync(diagnosticPath);
      if (!diagnosticStat.isFile() || diagnosticStat.isSymbolicLink() || diagnosticStat.size > 16 * 1024 * 1024) {
        return json(res, { ok: false, error: "Analysis diagnostic not found" }, 404);
      }
      const url = new URL(req.url || "/", `http://localhost:${appConfig.port}`);
      const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline";
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `${disposition}; filename="${diagnostic.fileName}"`,
        "X-Content-Type-Options": "nosniff"
      });
      res.end(readFileSync(diagnosticPath));
      return;
    } catch (error: any) {
      console.error("Analysis diagnostic error:", error?.message || error);
      return json(res, { ok: false, error: "Failed to read analysis diagnostic" }, 500);
    }
  });

  // Analysis outputs
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/analyses\/([^/]+)\/outputs\/(report|evaluation|proposals)$/, (req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const sessionId = safeDecodeId(match[2]);
    const runId = safeDecodeId(match[3]);
    const outputId = match[4];
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
        provider: adapter,
        providerId,
        sessionId,
        directory: session.directory,
        analysisConfig: appConfig.analysis,
        metaDir: appConfig.metaDir,
        limit: 50
      });
      const run = runs.find((item: any) => item.runId === runId);
      const output = (run?.outputs as Record<string, any> | undefined)?.[outputId];
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
      const url = new URL(req.url || "/", `http://localhost:${appConfig.port}`);
      const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Disposition": `${disposition}; filename="${output.fileName}"`,
        "X-Content-Type-Options": "nosniff"
      });
      res.end(readFileSync(outputPath));
      return;
    } catch (error: any) {
      console.error("Analysis output error:", error?.message || error);
      return json(res, { ok: false, error: "Failed to read analysis output" }, 500);
    }
  });

  // List analyses
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/analyses$/, async (_req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const sessionId = safeDecodeId(match[2]);
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
        provider: adapter,
        providerId,
        sessionId,
        directory: session.directory,
        analysisConfig: appConfig.analysis,
        metaDir: appConfig.metaDir,
        limit: 10
      });
      return json(res, { ok: true, runs });
    } catch (error: any) {
      console.error("Analysis status error:", error?.message || error);
      return json(res, { ok: false, error: "Failed to read analysis status" }, 500);
    }
  });
}
