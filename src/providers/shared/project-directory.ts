import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { RawSession } from "../interface.js";

type Row = Record<string, unknown>;

function projectKey(session: RawSession) {
  const metadata = session.metadata && typeof session.metadata === "object"
    ? session.metadata as Row
    : {};
  const key = metadata.projectKey;
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

function existingDirectory(value: unknown) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return null;
  try {
    const resolved = realpathSync(value);
    return statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Some transcript formats deliberately store only an opaque project key, not
 * a recoverable working directory. A user may map that key to a local project
 * in `analysis.providers.<provider>.projectPaths`; this remains viewer-owned
 * configuration and is never written back to provider data.
 */
export function withConfiguredProjectDirectory(
  providerId: string,
  session: RawSession,
  config: any
): RawSession {
  if (typeof session.directory === "string" && session.directory.trim()) return session;
  const key = projectKey(session);
  if (!key) return session;
  const configured = config?.analysis?.providers?.[providerId]?.projectPaths?.[key];
  const directory = existingDirectory(configured);
  if (!directory) return session;
  return {
    ...session,
    directory,
    metadata: {
      ...(session.metadata || {}),
      projectKey: key,
      projectDirectorySource: "configured"
    }
  };
}
