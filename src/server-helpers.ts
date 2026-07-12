import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getLocale } from "./i18n.js";
import { getProvider } from "./providers/index.js";

export const staticDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "static");

export function injectLocaleScript(body: string, contentType: string): string {
  if (typeof body !== "string" || !contentType.startsWith("text/html")) {
    return body;
  }

  const localeScript = `<script>window.__LOCALE__=${JSON.stringify(getLocale())}</script>`;
  return body.includes("</head>")
    ? body.replace("</head>", `  ${localeScript}\n</head>`)
    : body;
}

export function send(
  res: any,
  status: number,
  body: string,
  contentType = "text/html; charset=utf-8",
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": contentType, ...headers });
  res.end(injectLocaleScript(body, contentType));
}

export function readBody(req: any, maxBytes = 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk: any) => {
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
      } catch (err) {
        console.warn("Failed to parse request body JSON:", err);
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

export function safeDecodeId(encoded: string): string | null {
  try {
    const decoded = decodeURIComponent(encoded);
    if (decoded.length > 500) return null;
    return decoded;
  } catch (err) {
    console.warn("Failed to decode ID:", encoded, err);
    return null;
  }
}

export function json(res: any, data: any, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

export function isTrustedLocalJsonRequest(req: any): boolean {
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
  } catch (err) {
    console.warn("Failed to parse origin URL:", String(origin), err);
    return false;
  }
}

export function missingProviderResponse(providerId: string) {
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

export function safeJsonParse(value: any): any {
  if (typeof value !== "string") {
    return value || {};
  }

  try {
    return JSON.parse(value);
  } catch (err) {
    console.warn("Failed to parse JSON value:", err);
    return {};
  }
}

export function serveStatic(reqPath: string, res: any): void {
  const relativePath = reqPath.replace(/^\/static\//, "");
  const filePath = path.join(staticDir, relativePath);

  const contentType = filePath.endsWith(".css")
    ? "text/css; charset=utf-8"
    : filePath.endsWith(".js")
      ? "application/javascript; charset=utf-8"
      : "application/octet-stream";

  try {
    const body = readFileSync(filePath).toString();
    send(res, 200, body, contentType);
  } catch (err) {
    console.warn("Failed to read static file:", filePath, err);
    send(res, 404, "Not found", "text/plain; charset=utf-8");
  }
}
