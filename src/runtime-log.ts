import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const allowedLevels = new Set(["debug", "info", "warn", "error"]);
const sensitiveKeyPattern = /(authorization|cookie|secret|password|token|prompt|content|body|input|output|raw|transcript|command|args)/i;
const maxStringLength = 600;
const maxArrayItems = 25;
const maxObjectKeys = 40;

function dateSegment(date) {
  return date.toISOString().slice(0, 10);
}

function truncate(value) {
  if (value.length <= maxStringLength) {
    return value;
  }
  return `${value.slice(0, maxStringLength)}...`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeValue(value, depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return truncate(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return Number.isFinite(value) || typeof value !== "number" ? value : String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.slice(0, maxArrayItems).map((entry) => sanitizeValue(entry, depth + 1));
  }
  if (isPlainObject(value)) {
    if (depth >= 2) {
      return "[object]";
    }
    const sanitized = {};
    for (const [key, entry] of Object.entries(value).slice(0, maxObjectKeys)) {
      sanitized[key] = sensitiveKeyPattern.test(key)
        ? "[redacted]"
        : sanitizeValue(entry, depth + 1);
    }
    return sanitized;
  }
  return truncate(String(value));
}

function sanitizeEventName(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "runtime.event";
  }
  return value.trim().replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 120) || "runtime.event";
}

function sanitizeLevel(value) {
  return allowedLevels.has(value) ? value : "info";
}

export function getRuntimeLogDir(metaDir) {
  return path.join(metaDir, "logs");
}

export function getRuntimeLogPath(metaDir, now = new Date()) {
  return path.join(getRuntimeLogDir(metaDir), `runtime-${dateSegment(now)}.jsonl`);
}

function safeRuntimeId(encoded) {
  if (!encoded) {
    return undefined;
  }
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded.length <= 200 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function getRuntimeRouteContext(method, pathname) {
  if (pathname === "/favicon.ico" || pathname.startsWith("/static/")) {
    return null;
  }

  const patterns = [
    {
      pattern: /^\/api\/(providers|settings|reindex|batch)$/,
      route: "/api/:resource",
      actionIndex: 1
    },
    {
      pattern: /^\/api\/([a-z][a-z0-9-]*)\/(sessions|stats|batch)$/,
      route: "/api/:provider/:resource",
      providerIndex: 1,
      actionIndex: 2
    },
    {
      pattern: /^\/api\/([a-z][a-z0-9-]*)\/analysis\/prompt-preview$/,
      route: "/api/:provider/analysis/prompt-preview",
      providerIndex: 1,
      actionLiteral: "prompt-preview"
    },
    {
      pattern: /^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/analyses\/([^/]+)\/outputs\/([^/]+)$/,
      route: "/api/:provider/session/:sessionId/analyses/:runId/outputs/:output",
      providerIndex: 1,
      sessionIndex: 2,
      runIndex: 3,
      actionIndex: 4
    },
    {
      pattern: /^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/analyses\/([^/]+)\/implement$/,
      route: "/api/:provider/session/:sessionId/analyses/:runId/implement",
      providerIndex: 1,
      sessionIndex: 2,
      runIndex: 3,
      actionLiteral: "implement"
    },
    {
      pattern: /^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/analyses$/,
      route: "/api/:provider/session/:sessionId/analyses",
      providerIndex: 1,
      sessionIndex: 2
    },
    {
      pattern: /^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/(analyze|resume|export|flow-panel|metrics|flow|trace)$/,
      route: "/api/:provider/session/:sessionId/:action",
      providerIndex: 1,
      sessionIndex: 2,
      actionIndex: 3
    },
    {
      pattern: /^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)$/,
      route: "/api/:provider/session/:sessionId",
      providerIndex: 1,
      sessionIndex: 2
    },
    {
      pattern: /^\/api\/([a-z][a-z0-9-]*)\/session\/([^/]+)\/(star|rename|delete|restore|permanent-delete)$/,
      route: "/api/:provider/session/:sessionId/:action",
      providerIndex: 1,
      sessionIndex: 2,
      actionIndex: 3
    },
    {
      pattern: /^\/api\/session\/([^/]+)\/(star|rename|delete|restore|permanent-delete)$/,
      route: "/api/session/:sessionId/:action",
      sessionIndex: 1,
      actionIndex: 2
    },
    {
      pattern: /^\/([a-z][a-z0-9-]*)\/session\/([^/]+)$/,
      route: "/:provider/session/:sessionId",
      providerIndex: 1,
      sessionIndex: 2
    },
    {
      pattern: /^\/([a-z][a-z0-9-]*)\/(settings|stats|trash|search)$/,
      route: "/:provider/:page",
      providerIndex: 1,
      actionIndex: 2
    },
    {
      pattern: /^\/([a-z][a-z0-9-]*)$/,
      route: "/:provider",
      providerIndex: 1
    }
  ];

  for (const entry of patterns) {
    const match = pathname.match(entry.pattern);
    if (match) {
      return {
        method,
        route: entry.route,
        provider: entry.providerIndex ? match[entry.providerIndex] : undefined,
        sessionId: safeRuntimeId(entry.sessionIndex ? match[entry.sessionIndex] : undefined),
        runId: safeRuntimeId(entry.runIndex ? match[entry.runIndex] : undefined),
        action: entry.actionLiteral || (entry.actionIndex ? match[entry.actionIndex] : undefined)
      };
    }
  }

  return { method, route: "/unmatched" };
}

export function runtimeLevelForStatus(statusCode) {
  if (statusCode >= 500) return "error";
  if (statusCode >= 400) return "warn";
  return "info";
}

export function runtimeErrorMessage(error) {
  return error?.message || String(error || "Unknown error");
}

export function runtimeExecutableName(command) {
  const executable = command?.resolvedExecutable || command?.executable || "";
  return executable ? path.basename(String(executable)) : "";
}

export function buildRuntimeEvent(input: any = {}, now = new Date()) {
  const source = isPlainObject(input) ? input : {};
  const record = {
    ts: now.toISOString(),
    level: sanitizeLevel(source.level),
    event: sanitizeEventName(source.event)
  };

  for (const [key, value] of Object.entries(source)) {
    if (key === "ts" || key === "level" || key === "event" || value === undefined) {
      continue;
    }
    record[key] = sensitiveKeyPattern.test(key)
      ? "[redacted]"
      : sanitizeValue(value);
  }

  return record;
}

export function recordRuntimeEvent(metaDir, input: any = {}, options: any = {}) {
  if (!metaDir) {
    return null;
  }

  const now = options.now || new Date();
  const record = buildRuntimeEvent(input, now);
  const logPath = getRuntimeLogPath(metaDir, now);
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
    return record;
  } catch (error) {
    console.warn(`Runtime log write failed: ${error?.message || error}`);
    return null;
  }
}
