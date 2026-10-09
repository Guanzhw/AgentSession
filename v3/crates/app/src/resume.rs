//! Trusted local terminal launch. Provider arguments are data, never shell source.
use agentsession_core::{Core, CoreError, NpmResumeEntry, ResumeCommandSpec};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ShellSpec {
    executable: String,
    #[serde(default = "default_shell_args")]
    args: Vec<String>,
}
fn default_shell_args() -> Vec<String> {
    vec!["-NoExit".into(), "-NoLogo".into()]
}

pub fn parse_shell(value: &Value) -> Result<Option<ShellSpec>, String> {
    if value.is_null() {
        return Ok(None);
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ConfiguredShell {
        executable: Option<String>,
        args: Option<Vec<String>>,
    }
    let shell: ConfiguredShell =
        serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
    Ok(shell.executable.map(|executable| ShellSpec {
        executable,
        args: shell.args.unwrap_or_else(default_shell_args),
    }))
}
#[derive(Clone)]
pub struct ResumeConfig {
    pub enabled: bool,
    pub commands: BTreeMap<String, Option<ResumeCommandSpec>>,
    pub shell: Option<ShellSpec>,
}
impl Default for ResumeConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            commands: BTreeMap::new(),
            shell: None,
        }
    }
}
pub fn parse_commands(
    value: &Value,
) -> Result<BTreeMap<String, Option<ResumeCommandSpec>>, String> {
    let object = value.as_object().ok_or("expected provider command map")?;
    object
        .iter()
        .map(|(provider, value)| {
            if !["opencode", "claude-code", "codex", "pi", "deepseek-harness"]
                .contains(&provider.as_str())
            {
                return Err(format!("unknown provider {provider}"));
            }
            let spec = if value.is_null() || value == &Value::Bool(false) {
                None
            } else {
                let mut command = value.clone();
                if let Some(stdin) = command
                    .as_object_mut()
                    .and_then(|object| object.remove("stdin"))
                {
                    if stdin != "prompt" {
                        return Err(format!("{provider}.stdin must be \"prompt\" when provided"));
                    }
                }
                // 2.0 validates this field but does not feed it to a process.
                // Retain it in the saved document, normalize only the command.
                Some(
                    serde_json::from_value(command)
                        .map_err(|error| format!("{provider}: {error}"))?,
                )
            };
            Ok((provider.clone(), spec))
        })
        .collect()
}
impl ResumeConfig {
    pub fn validate(&self) -> Result<(), String> {
        for spec in self.commands.values().flatten() {
            if spec.executable.trim().is_empty()
                || spec.executable.contains('\0')
                || spec.args.iter().any(|s| s.contains('\0'))
            {
                return Err(
                    "resume command requires a nonempty executable and NUL-free arguments".into(),
                );
            }
        }
        if self.shell.as_ref().is_some_and(|shell| {
            shell.executable.trim().is_empty()
                || shell.executable.contains('\0')
                || shell.args.iter().any(|s| s.contains('\0'))
        }) {
            return Err("resumeShell requires a nonempty executable and NUL-free arguments".into());
        }
        Ok(())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeInfo {
    pub allow_terminal_launch: bool,
    pub available: bool,
    pub diagnostic: Option<String>,
    pub command: Option<ResolvedCommand>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedCommand {
    executable: String,
    resolved_executable: Option<PathBuf>,
    args: Vec<String>,
    cwd: PathBuf,
}
fn executable(name: &str) -> Option<PathBuf> {
    let requested = Path::new(name);
    if requested.is_absolute() {
        return requested.is_file().then(|| requested.into());
    }
    let mut finder = Command::new(if cfg!(windows) { "where.exe" } else { "which" });
    finder.arg(name).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        finder.creation_flags(0x08000000);
    }
    let output = finder.output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(PathBuf::from)
        .find(|path| {
            path.is_file()
                && (!cfg!(windows)
                    || path.extension().is_some_and(|ext| {
                        ["exe", "cmd", "bat"]
                            .iter()
                            .any(|candidate| ext.to_string_lossy().eq_ignore_ascii_case(candidate))
                    }))
        })
}
fn windows_executable_diagnostic(path: &Path) -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    let extension = path.extension().map(|value| value.to_string_lossy());
    if extension
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
    {
        return None;
    }
    Some(format!(
        "Resume executable {} is unsupported on Windows; batch and script shims cannot preserve arguments safely. Configure a direct .exe command",
        path.display()
    ))
}

/// Resolve only provider-declared npm defaults. A shim supplies its installation
/// prefix, never code or arguments; package.json is the checked entry boundary.
fn npm_entry(shim: &Path, npm: NpmResumeEntry) -> Result<(PathBuf, Vec<String>), String> {
    if !shim
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd"))
        || !shim
            .file_stem()
            .is_some_and(|stem| stem.eq_ignore_ascii_case(npm.bin))
    {
        return Err(format!("Unsupported npm shim layout: {}", shim.display()));
    }
    let prefix = shim.parent().expect("resolved executable has a parent");
    let package = prefix.join("node_modules").join(npm.package);
    let manifest_path = package.join("package.json");
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).map_err(|error| {
            format!(
                "Cannot read npm manifest {}: {error}",
                manifest_path.display()
            )
        })?)
        .map_err(|error| format!("Invalid npm manifest {}: {error}", manifest_path.display()))?;
    if manifest["name"].as_str() != Some(npm.package) {
        return Err(format!("npm manifest package name must be {}", npm.package));
    }
    let bin = manifest["bin"][npm.bin]
        .as_str()
        .filter(|value| !value.is_empty() && !value.contains('\0'))
        .ok_or_else(|| format!("npm manifest requires a bin.{} entry", npm.bin))?;
    let relative = Path::new(bin);
    if relative.components().any(|component| {
        !matches!(
            component,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )
    }) {
        return Err("npm bin entry must be relative and cannot escape its package".into());
    }
    let entry = package.join(relative);
    let package_root = package
        .canonicalize()
        .map_err(|error| format!("Cannot resolve npm package: {error}"))?;
    let canonical_entry = entry
        .canonicalize()
        .map_err(|error| format!("Cannot resolve npm bin entry {}: {error}", entry.display()))?;
    if !canonical_entry.starts_with(&package_root) || !canonical_entry.is_file() {
        return Err("npm bin entry is outside its package or is not a file".into());
    }
    let extension = entry
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if extension.eq_ignore_ascii_case("exe") {
        return Ok((entry, Vec::new()));
    }
    if extension.eq_ignore_ascii_case("js") {
        let sibling = prefix.join("node.exe");
        let node = if sibling.is_file() {
            Some(sibling)
        } else {
            executable("node.exe")
        }
        .ok_or("npm JavaScript entry requires a direct node.exe executable")?;
        if let Some(diagnostic) = windows_executable_diagnostic(&node) {
            return Err(diagnostic);
        }
        return Ok((node, vec![entry.to_string_lossy().into_owned()]));
    }
    Err(format!("Unsupported npm bin entry: {}", entry.display()))
}
fn shell_spec(config: &ResumeConfig) -> ShellSpec {
    config.shell.clone().unwrap_or_else(|| ShellSpec {
        executable: if executable("pwsh.exe").is_some() {
            "pwsh.exe"
        } else {
            "powershell.exe"
        }
        .into(),
        args: default_shell_args(),
    })
}
fn shell_diagnostic(shell: &ShellSpec) -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    let Some(path) = executable(&shell.executable) else {
        return Some(format!("Shell {} was not found", shell.executable));
    };
    if path
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("pwsh.exe"))
    {
        None
    } else {
        Some("Resume requires PowerShell 7.3 or newer (pwsh.exe) for exact Windows executable arguments".into())
    }
}
fn verify_shell_version(shell: &Path) -> Result<(), String> {
    let mut child = Command::new(shell)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$PSVersionTable.PSVersion.ToString()",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Cannot check PowerShell version: {error}"))?;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_none()
    {
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("PowerShell version check timed out".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    let version = String::from_utf8_lossy(&output.stdout);
    let mut parts = version.trim().split('.');
    let major = parts.next().and_then(|part| part.parse::<u32>().ok());
    let minor = parts.next().and_then(|part| part.parse::<u32>().ok());
    if !output.status.success()
        || !matches!((major, minor), (Some(major), Some(minor)) if major > 7 || major == 7 && minor >= 3)
    {
        return Err(
            "Resume requires PowerShell 7.3 or newer for exact Windows executable arguments".into(),
        );
    }
    Ok(())
}
pub fn resolve(
    core: &Core,
    config: &ResumeConfig,
    provider: &str,
    id: &str,
) -> Result<ResumeInfo, CoreError> {
    let (default, directory) = core.resume_spec(provider, id)?;
    let (spec, npm) = match config.commands.get(provider) {
        Some(command) => (command.clone(), None),
        None => match default {
            Some(default) => (Some(default.command), default.npm),
            None => (None, None),
        },
    };
    let mut result = ResumeInfo {
        allow_terminal_launch: config.enabled,
        available: false,
        diagnostic: None,
        command: None,
    };
    let Some(spec) = spec else {
        result.diagnostic = Some("Resume command is disabled or unavailable for this provider; configure resumeCommands to enable it".into());
        return Ok(result);
    };
    let raw = spec.cwd.as_deref().or(directory.as_deref()).unwrap_or("");
    let cwd = Path::new(raw);
    if !cwd.is_absolute() || !cwd.is_dir() {
        result.diagnostic = Some("Resume requires an absolute existing directory".into());
        return Ok(result);
    }
    // Keep the user-visible path spelling; canonicalize validates access and symlinks.
    if let Err(error) = cwd.canonicalize() {
        result.diagnostic = Some(format!("Cannot resolve project directory: {error}"));
        return Ok(result);
    }
    let mut args: Vec<String> = spec
        .args
        .iter()
        .map(|arg| arg.replace("{sessionId}", id).replace("{projectPath}", raw))
        .collect();
    let mut resolved_executable = executable(&spec.executable);
    if cfg!(windows) {
        if let (Some(path), Some(npm)) = (&resolved_executable, npm) {
            if windows_executable_diagnostic(path).is_some() {
                match npm_entry(path, npm) {
                    Ok((entry, mut prefix_args)) => {
                        prefix_args.append(&mut args);
                        args = prefix_args;
                        resolved_executable = Some(entry);
                    }
                    Err(diagnostic) => {
                        result.diagnostic = Some(diagnostic);
                        return Ok(result);
                    }
                }
            }
        }
    }
    result.available = resolved_executable.is_some();
    result.diagnostic = if let Some(path) = &resolved_executable {
        windows_executable_diagnostic(path)
    } else {
        Some(format!("Executable {} was not found", spec.executable))
    };
    if result.diagnostic.is_none() {
        result.diagnostic = shell_diagnostic(&shell_spec(config));
    }
    result.available &= result.diagnostic.is_none();
    if !cfg!(windows) {
        result.available = false;
        result.diagnostic =
            Some("Terminal launching is currently supported on Windows only".into());
    }
    result.command = Some(ResolvedCommand {
        executable: spec.executable,
        resolved_executable,
        args,
        cwd: cwd.into(),
    });
    Ok(result)
}
pub fn launch(info: ResumeInfo, config: &ResumeConfig) -> Result<Value, String> {
    if !config.enabled {
        return Err("Terminal launch is disabled for this process".into());
    }
    if !info.available {
        return Err(info
            .diagnostic
            .unwrap_or_else(|| "Resume unavailable".into()));
    }
    let spec = info.command.ok_or("Resume command unavailable")?;
    let shell = shell_spec(config);
    let shell_executable = executable(&shell.executable)
        .ok_or_else(|| format!("Shell {} was not found", shell.executable))?;
    if let Some(diagnostic) = shell_diagnostic(&shell) {
        return Err(diagnostic);
    }
    verify_shell_version(&shell_executable)?;
    let payload = json!({"executable":spec.resolved_executable,"args":spec.args,"cwd":spec.cwd});
    // Start-Process gives the terminal its own console handles even when the Web
    // server was launched with redirected stdout/stderr by a background host.
    let program = "$ErrorActionPreference='Stop';$PSNativeCommandArgumentPassing='Standard';$spec=$env:AGENTSESSION_RESUME_SPEC|ConvertFrom-Json;Set-Location -LiteralPath $spec.cwd;& $spec.executable @($spec.args);if($LASTEXITCODE){exit $LASTEXITCODE}";
    let encoded = STANDARD.encode(
        program
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let mut shell_args = shell.args;
    shell_args.extend(["-EncodedCommand".into(), encoded]);
    let host_payload = json!({"executable":shell_executable,"args":shell_args,"cwd":spec.cwd});
    let mut command = Command::new(&shell_executable);
    command.args(["-NoLogo", "-NoProfile", "-Command", "$ErrorActionPreference='Stop';$spec=$env:AGENTSESSION_TERMINAL_SPEC|ConvertFrom-Json;$child=Start-Process -FilePath $spec.executable -ArgumentList @($spec.args) -WorkingDirectory $spec.cwd -WindowStyle Normal -PassThru;Write-Output $child.Id"])
        .env("AGENTSESSION_RESUME_SPEC", payload.to_string())
        .env("AGENTSESSION_TERMINAL_SPEC", host_payload.to_string())
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Terminal launch failed: {error}"))?;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            break;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Terminal launch wrapper did not confirm startup within 5 seconds".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Terminal launch wrapper failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let pid = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<u32>()
        .map_err(|_| "Terminal launch wrapper returned no process ID")?;
    Ok(json!({"launched":true,"pid":pid}))
}
