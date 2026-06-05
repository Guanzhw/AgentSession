import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { ProviderId, ResumeCommandSpec } from "./providers/interface.js";

const BUILTIN_COMMANDS: Partial<Record<ProviderId, ResumeCommandSpec>> = {
  opencode: { executable: "opencode", args: ["--session", "{sessionId}"] },
  "claude-code": { executable: "claude", args: ["--resume", "{sessionId}"] },
  codex: { executable: "codex", args: ["resume", "{sessionId}"] },
  gemini: { executable: "gemini", args: ["--resume", "{sessionId}"] }
};

function isCommandSpec(value): value is ResumeCommandSpec {
  return Boolean(
    value
    && typeof value === "object"
    && typeof value.executable === "string"
    && value.executable.trim()
    && Array.isArray(value.args)
    && value.args.every((arg) => typeof arg === "string")
  );
}

function quoteDisplayArg(value) {
  if (!/[\s"'`$;&|<>()[\]{}]/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}

function resolveExecutable(executable) {
  if (path.isAbsolute(executable)) {
    return existsSync(executable) ? executable : null;
  }

  const finder = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(finder, [executable], { encoding: "utf-8", windowsHide: true });
  if (result.status !== 0) {
    return null;
  }

  const candidates = String(result.stdout || "").split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (process.platform !== "win32") {
    return candidates[0] || null;
  }

  // npm commands often expose both PowerShell and cmd wrappers. Prefer a
  // directly executable wrapper so user data is never evaluated as shell code.
  return candidates.find((entry) => /\.(exe|cmd|bat)$/i.test(entry)) || candidates[0] || null;
}

export function resolveProjectDirectory(directory) {
  if (!directory || typeof directory !== "string" || !path.isAbsolute(directory)) {
    return null;
  }

  try {
    const resolved = realpathSync(directory);
    return statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

export function getResumeCommand(providerId, sessionId, directory, configuredCommands = {}) {
  const configured = configuredCommands?.[providerId];
  const spec = isCommandSpec(configured) ? configured : BUILTIN_COMMANDS[providerId];
  const cwd = resolveProjectDirectory(isCommandSpec(configured) && configured.cwd ? configured.cwd : directory);
  if (!spec || !cwd) {
    return null;
  }

  const replace = (value) => value
    .replaceAll("{sessionId}", sessionId)
    .replaceAll("{projectPath}", cwd);
  const executable = spec.executable;
  const args = spec.args.map(replace);
  const resolvedExecutable = resolveExecutable(executable);
  return {
    executable,
    resolvedExecutable,
    args,
    cwd,
    display: [executable, ...args].map(quoteDisplayArg).join(" "),
    available: Boolean(resolvedExecutable)
  };
}

export function launchResumeCommand(command) {
  if (process.platform !== "win32") {
    throw new Error("Terminal launching is currently supported on Windows only");
  }
  if (!command?.resolvedExecutable || !command?.cwd) {
    throw new Error("Resume command is not available");
  }

  const terminal = resolveExecutable("wt.exe");
  const powershell = resolveExecutable("pwsh.exe") || resolveExecutable("powershell.exe");
  if (!terminal || !powershell) {
    throw new Error("Windows Terminal and PowerShell are required");
  }

  // The fixed PowerShell program reads data from the environment. Session IDs,
  // command arguments, and project paths never become PowerShell source text.
  const payload = Buffer.from(JSON.stringify({
    executable: command.resolvedExecutable,
    args: command.args,
    cwd: command.cwd
  }), "utf-8").toString("base64");
  const script = [
    "$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OPENSESSIONVIEWER_RESUME_SPEC))",
    "$spec=$json|ConvertFrom-Json",
    "Set-Location -LiteralPath $spec.cwd",
    "& $spec.executable @($spec.args)"
  ].join(";");

  const child = spawn(terminal, [
    "-d", command.cwd,
    powershell,
    "-NoExit",
    "-NoLogo",
    "-Command",
    script
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, OPENSESSIONVIEWER_RESUME_SPEC: payload }
  });
  child.unref();
}
