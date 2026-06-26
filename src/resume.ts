import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { ProviderAdapter, ResumeCommandSpec, ResumeShellSpec } from "./providers/interface.js";

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

function isShellSpec(value): value is ResumeShellSpec {
  return Boolean(
    value
    && typeof value === "object"
    && typeof value.executable === "string"
    && value.executable.trim()
    && (value.args === undefined || (
      Array.isArray(value.args)
      && value.args.every((arg) => typeof arg === "string")
    ))
  );
}

function quoteDisplayArg(value) {
  if (!/[\s"'`$;&|<>()[\]{}]/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}

const WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat"];
const DIRECT_POWERSHELL_LAUNCH_ENV = "OPENSESSIONVIEWER_DIRECT_POWERSHELL_LAUNCH_SPEC";

export function resolveWindowsExecutableCandidate(candidates, exists = existsSync) {
  const direct = candidates.find((entry) => {
    const lower = entry.toLowerCase();
    return WINDOWS_EXECUTABLE_EXTENSIONS.some((extension) => lower.endsWith(extension));
  });
  if (direct) {
    return direct;
  }

  for (const entry of candidates) {
    if (path.win32.extname(entry)) {
      continue;
    }
    for (const extension of WINDOWS_EXECUTABLE_EXTENSIONS) {
      const sibling = `${entry}${extension}`;
      if (exists(sibling)) {
        return sibling;
      }
    }
  }

  return candidates[0] || null;
}

export function resolveExecutable(executable) {
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
  return resolveWindowsExecutableCandidate(candidates);
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

export function getResumeCommand(provider: ProviderAdapter, sessionId, directory, configuredCommands = {}) {
  const configured = configuredCommands?.[provider.id];
  if (configured === false || configured === null) {
    return null;
  }
  const spec = isCommandSpec(configured) ? configured : provider.resumeCommand;
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

export function buildPowerShellResumeArgs(powershell, shellArgs = ["-NoExit", "-NoLogo"]) {
  const script = [
    "$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OPENSESSIONVIEWER_RESUME_SPEC))",
    "$spec=$json|ConvertFrom-Json",
    "Set-Location -LiteralPath $spec.cwd",
    "& $spec.executable @($spec.args)"
  ].join(";");
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");

  return [
    powershell,
    ...shellArgs,
    "-EncodedCommand",
    encodedScript
  ];
}

export function resolvePowerShellLaunch(configuredShell = null, resolve = resolveExecutable) {
  const shellSpec = isShellSpec(configuredShell) ? configuredShell : null;
  const powershell = shellSpec
    ? resolve(shellSpec.executable)
    : resolve("pwsh.exe") || resolve("powershell.exe");
  if (!powershell) {
    throw new Error("PowerShell is required");
  }

  return {
    terminal: resolve("wt.exe") || null,
    powershell,
    shellArgs: shellSpec?.args || ["-NoExit", "-NoLogo"]
  };
}

function buildPowerShellStartProcessArgs(powershell) {
  const script = [
    `$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:${DIRECT_POWERSHELL_LAUNCH_ENV}))`,
    "$spec=$json|ConvertFrom-Json",
    "$startInfo=@{FilePath=$spec.executable;ArgumentList=@($spec.args);WorkingDirectory=$spec.cwd;WindowStyle='Normal'}",
    "Start-Process @startInfo|Out-Null"
  ].join(";");

  return [
    powershell,
    "-NoLogo",
    "-NoProfile",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")
  ];
}

export function buildPowerShellLaunchSpec({ cwd, terminal, powershellArgs }) {
  if (!cwd || typeof cwd !== "string") {
    throw new Error("Working directory is required");
  }
  if (!Array.isArray(powershellArgs) || !powershellArgs[0]) {
    throw new Error("PowerShell launch arguments are required");
  }

  if (terminal) {
    return {
      executable: terminal,
      args: ["-d", cwd, ...powershellArgs],
      cwd: undefined,
      detached: true,
      windowsHide: true,
      env: {}
    };
  }

  const directLaunchSpec = Buffer.from(JSON.stringify({
    executable: powershellArgs[0],
    args: powershellArgs.slice(1),
    cwd
  }), "utf-8").toString("base64");

  return {
    executable: powershellArgs[0],
    args: buildPowerShellStartProcessArgs(powershellArgs[0]).slice(1),
    cwd: undefined,
    // Direct detached PowerShell can exit without running the encoded command
    // from hidden server hosts. Use a short-lived wrapper that starts the
    // visible PowerShell process and then exits.
    detached: false,
    windowsHide: true,
    env: { [DIRECT_POWERSHELL_LAUNCH_ENV]: directLaunchSpec }
  };
}

export function spawnPowerShellLaunch({ cwd, terminal, powershellArgs, env }) {
  const launch = buildPowerShellLaunchSpec({ cwd, terminal, powershellArgs });
  const child = spawn(launch.executable, launch.args, {
    detached: launch.detached,
    stdio: "ignore",
    windowsHide: launch.windowsHide,
    cwd: launch.cwd,
    env: { ...process.env, ...env, ...launch.env }
  });
  child.unref();
  return child;
}

export function launchResumeCommand(command, configuredShell = null) {
  if (process.platform !== "win32") {
    throw new Error("Terminal launching is currently supported on Windows only");
  }
  if (!command?.resolvedExecutable || !command?.cwd) {
    throw new Error("Resume command is not available");
  }

  const launchHost = resolvePowerShellLaunch(configuredShell);

  // The fixed PowerShell program reads data from the environment. Session IDs,
  // command arguments, and project paths never become PowerShell source text.
  const payload = Buffer.from(JSON.stringify({
    executable: command.resolvedExecutable,
    args: command.args,
    cwd: command.cwd
  }), "utf-8").toString("base64");
  spawnPowerShellLaunch({
    cwd: command.cwd,
    terminal: launchHost.terminal,
    powershellArgs: buildPowerShellResumeArgs(launchHost.powershell, launchHost.shellArgs),
    env: { OPENSESSIONVIEWER_RESUME_SPEC: payload }
  });
}
