use crate::SourceArgs;
use agentsession_core::{ProviderDefaultPaths, SourceConfig, TokenPricingDocument};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    env,
    error::Error,
    fmt, fs,
    path::{Path, PathBuf},
};

#[derive(Debug)]
pub struct ConfigError(String);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Error for ConfigError {}

type Result<T> = std::result::Result<T, ConfigError>;
type ProjectPaths = BTreeMap<String, BTreeMap<String, String>>;

#[derive(Clone, Copy)]
pub struct McpLimits {
    pub search_limit: usize,
    pub timeline_limit: usize,
    pub event_max_chars: usize,
    pub context_window: usize,
}

impl Default for McpLimits {
    fn default() -> Self {
        Self {
            search_limit: 20,
            timeline_limit: 50,
            event_max_chars: 4_000,
            context_window: 5,
        }
    }
}

pub struct SelectedConfig {
    file: FileConfig,
    path: PathBuf,
    loaded: bool,
}

#[derive(Default)]
struct FileConfig {
    port: Option<u16>,
    open: bool,
    codex_dir: Option<PathBuf>,
    opencode_db: Option<PathBuf>,
    claude_dir: Option<PathBuf>,
    pi_dir: Option<PathBuf>,
    dsh_dir: Option<PathBuf>,
    meta_dir: Option<PathBuf>,
    index_dir: Option<PathBuf>,
    cache_dir: Option<PathBuf>,
    project_paths: ProjectPaths,
    token_pricing: TokenPricingDocument,
    resume: crate::resume::ResumeConfig,
    mcp: McpLimits,
}

impl SelectedConfig {
    pub fn load(cli_path: Option<PathBuf>) -> Result<Self> {
        let env_path = env::var_os("AGENTSESSION_CONFIG").map(PathBuf::from);
        let explicit = cli_path.is_some() || env_path.is_some();
        let path = match cli_path.or(env_path) {
            Some(path) => path,
            None => default_state_dir(&home_dir()?).join("config.json"),
        };
        let body = match fs::read_to_string(&path) {
            Ok(body) => body,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !explicit => {
                return Ok(Self {
                    file: FileConfig::default(),
                    path,
                    loaded: false,
                });
            }
            Err(error) => return Err(ConfigError(format!("config {}: {error}", path.display()))),
        };
        let value: Value = serde_json::from_str(&body).map_err(|error| {
            ConfigError(format!("config {}: invalid JSON: {error}", path.display()))
        })?;
        let file = parse_file_config(&path, &value)?;
        Ok(Self {
            file,
            path,
            loaded: true,
        })
    }

    pub fn resume_config(&self, disabled: bool) -> crate::resume::ResumeConfig {
        let mut config = self.file.resume.clone();
        config.enabled = !disabled;
        config
    }

    pub fn mcp_limits(&self) -> McpLimits {
        self.file.mcp
    }

    pub fn token_pricing(&self) -> TokenPricingDocument {
        self.file.token_pricing.clone()
    }

    pub fn open_browser(&self, cli_open: bool) -> bool {
        cli_open || self.file.open
    }

    pub fn settings_snapshot(&self, sources: &SourceConfig, port: u16) -> Value {
        json!({
            "configFile": { "path": self.path, "loaded": self.loaded },
            "startup": {
                "port": port,
                "sources": {
                    "codexDir": sources.codex_dir,
                    "dbPath": sources.opencode_db,
                    "claudeDir": sources.claude_dir,
                    "piDir": sources.pi_dir,
                    "dshDir": sources.dsh_dir,
                },
                "state": {
                    "metaDir": sources.meta_dir,
                    "indexDir": sources.index_dir,
                    "cacheDir": sources.cache_dir,
                },
            },
            "runtimeEditable": ["projectPaths", "resumeCommands", "resumeShell", "tokenPricing"],
            "runtime": {
                "projectPaths": self.file.project_paths,
                "resumeCommands": self.file.resume.commands,
                "resumeShell": self.file.resume.shell,
                "tokenPricing": self.file.token_pricing,
            },
        })
    }

    pub fn resolve(&self, cli: SourceArgs) -> Result<SourceConfig> {
        let home = home_dir()?;
        let defaults = ProviderDefaultPaths::discover(&home);
        let state = default_state_dir(&home);
        let meta = choose(
            cli.meta_dir,
            "AGENTSESSION_V3_META_DIR",
            &self.file.meta_dir,
            state.join("meta"),
        )?;
        Ok(SourceConfig {
            codex_dir: choose(
                cli.codex_dir,
                "AGENTSESSION_CODEX_DIR",
                &self.file.codex_dir,
                defaults.codex_dir,
            )?,
            opencode_db: choose(
                cli.opencode_db,
                "AGENTSESSION_DB_PATH",
                &self.file.opencode_db,
                defaults.opencode_db,
            )?,
            claude_dir: choose(
                cli.claude_dir,
                "AGENTSESSION_CLAUDE_DIR",
                &self.file.claude_dir,
                defaults.claude_dir,
            )?,
            pi_dir: choose(
                cli.pi_dir,
                "AGENTSESSION_PI_DIR",
                &self.file.pi_dir,
                defaults.pi_dir,
            )?,
            dsh_dir: choose(
                cli.dsh_dir,
                "AGENTSESSION_DSH_DIR",
                &self.file.dsh_dir,
                defaults.dsh_dir,
            )?,
            meta_dir: meta,
            index_dir: choose(
                cli.index_dir,
                "AGENTSESSION_V3_INDEX_DIR",
                &self.file.index_dir,
                state.join("index"),
            )?,
            cache_dir: choose(
                cli.cache_dir,
                "AGENTSESSION_V3_CACHE_DIR",
                &self.file.cache_dir,
                state.join("cache"),
            )?,
        })
    }

    pub fn serve_port(&self, cli_port: Option<u16>) -> Result<u16> {
        let port = match cli_port {
            Some(0) => {
                return Err(ConfigError(
                    "--port: expected a port from 1 to 65535".into(),
                ));
            }
            Some(port) => port,
            None => match env::var("PORT") {
                Ok(raw) => raw
                    .parse::<u16>()
                    .ok()
                    .filter(|port| *port > 0)
                    .ok_or_else(|| ConfigError("PORT: expected a port from 1 to 65535".into()))?,
                Err(env::VarError::NotPresent) => self.file.port.unwrap_or(3457),
                Err(error) => return Err(ConfigError(format!("PORT: {error}"))),
            },
        };
        Ok(port)
    }
}

pub struct RuntimeSettings {
    pub snapshot: Value,
    pub resume: crate::resume::ResumeConfig,
    pub token_pricing: TokenPricingDocument,
}

pub enum SettingsError {
    Invalid(String),
    Save(String),
}

impl RuntimeSettings {
    pub fn update(&mut self, patch: Value) -> std::result::Result<Value, SettingsError> {
        let object = patch
            .as_object()
            .ok_or_else(|| SettingsError::Invalid("Expected a settings object".into()))?;
        let mut next = self.resume.clone();
        for (key, value) in object {
            match key.as_str() {
                "resumeCommands" => {
                    next.commands =
                        crate::resume::parse_commands(value).map_err(SettingsError::Invalid)?
                }
                "resumeShell" => {
                    next.shell =
                        crate::resume::parse_shell(value).map_err(SettingsError::Invalid)?
                }
                "projectPaths" => {
                    parse_project_paths(value).map_err(SettingsError::Invalid)?;
                }
                "tokenPricing" => {
                    parse_token_pricing(value).map_err(SettingsError::Invalid)?;
                }
                _ => {
                    return Err(SettingsError::Invalid(format!(
                        "{key} is not runtime-editable; only projectPaths, resumeCommands, resumeShell and tokenPricing can be saved"
                    )));
                }
            }
        }
        next.validate().map_err(SettingsError::Invalid)?;
        let path = Path::new(
            self.snapshot["configFile"]["path"]
                .as_str()
                .expect("selected config path"),
        );
        let save_error = |error: std::io::Error| {
            SettingsError::Save(format!("Could not save configuration: {error}"))
        };
        let mut disk: Value = match fs::read_to_string(path) {
            Ok(body) => serde_json::from_str(&body).map_err(|error| {
                SettingsError::Save(format!("Existing configuration is invalid JSON: {error}"))
            })?,
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    && self.snapshot["configFile"]["loaded"] == false =>
            {
                json!({})
            }
            Err(error) => return Err(save_error(error)),
        };
        let disk_object = disk.as_object_mut().ok_or_else(|| {
            SettingsError::Save("Existing configuration must be an object".into())
        })?;
        for (key, value) in object {
            disk_object.insert(key.clone(), value.clone());
        }
        let mut merged = parse_file_config(path, &disk)
            .map_err(|error| SettingsError::Save(error.to_string()))?;
        merged.resume.enabled = self.resume.enabled;
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent).map_err(save_error)?;
        }
        use std::sync::atomic::{AtomicU64, Ordering};
        static ATTEMPT: AtomicU64 = AtomicU64::new(0);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("current clock is after epoch")
            .as_nanos();
        let temp = path.with_extension(format!(
            "{}.{now}.{}.tmp",
            std::process::id(),
            ATTEMPT.fetch_add(1, Ordering::Relaxed)
        ));
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(save_error)?;
        let result = (|| {
            file.write_all(
                serde_json::to_string_pretty(&disk)
                    .expect("JSON value serializes")
                    .as_bytes(),
            )?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temp, path)
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(&temp);
            return Err(save_error(error));
        }
        self.resume = merged.resume;
        self.token_pricing = merged.token_pricing;
        self.snapshot["configFile"]["loaded"] = json!(true);
        self.snapshot["runtime"] = json!({ "projectPaths": merged.project_paths, "resumeCommands": self.resume.commands, "resumeShell": self.resume.shell, "tokenPricing": self.token_pricing });
        Ok(self.snapshot.clone())
    }
}

fn parse_file_config(path: &Path, value: &Value) -> Result<FileConfig> {
    let object = value
        .as_object()
        .ok_or_else(|| ConfigError(format!("config {}: expected a JSON object", path.display())))?;
    let mut file = FileConfig::default();
    for (key, value) in object {
        match key.as_str() {
            "resumeCommands" => {
                file.resume.commands = crate::resume::parse_commands(value)
                    .map_err(|message| invalid(&path, key, &message))?
            }
            "resumeShell" => {
                file.resume.shell = crate::resume::parse_shell(value)
                    .map_err(|message| invalid(&path, key, &message))?
            }
            "projectPaths" => {
                file.project_paths =
                    parse_project_paths(value).map_err(|message| invalid(path, key, &message))?
            }
            "tokenPricing" => {
                file.token_pricing =
                    parse_token_pricing(value).map_err(|message| invalid(path, key, &message))?
            }
            "mcp" => file.mcp = parse_mcp_limits(path, value)?,
            "open" => {
                file.open = value
                    .as_bool()
                    .ok_or_else(|| invalid(path, key, "expected a boolean"))?;
            }
            // These 2.0 file fields have no runtime consumer: language is
            // selected by the browser, indexing is incremental, and launch
            // permission belongs exclusively to process startup.
            "lang" => {
                value
                    .as_str()
                    .ok_or_else(|| invalid(path, key, "expected a string"))?;
            }
            "reindex" | "allowTerminalLaunch" => {
                value
                    .as_bool()
                    .ok_or_else(|| invalid(path, key, "expected a boolean"))?;
            }
            "port" => {
                let raw = value
                    .as_u64()
                    .ok_or_else(|| invalid(&path, key, "expected an integer port"))?;
                file.port = Some(
                    u16::try_from(raw)
                        .ok()
                        .filter(|port| *port > 0)
                        .ok_or_else(|| invalid(&path, key, "expected a port from 1 to 65535"))?,
                );
            }
            "codexDir" => file.codex_dir = Some(path_value(&path, key, value)?),
            "dbPath" => file.opencode_db = Some(path_value(&path, key, value)?),
            "claudeDir" => file.claude_dir = Some(path_value(&path, key, value)?),
            "piDir" => file.pi_dir = Some(path_value(&path, key, value)?),
            "dshDir" => file.dsh_dir = Some(path_value(&path, key, value)?),
            "metaDir" => file.meta_dir = Some(path_value(&path, key, value)?),
            "indexDir" => file.index_dir = Some(path_value(&path, key, value)?),
            "cacheDir" => file.cache_dir = Some(path_value(&path, key, value)?),
            _ => {
                return Err(invalid(&path, key, "unsupported key in 3.0 configuration"));
            }
        }
    }
    file.resume
        .validate()
        .map_err(|message| invalid(&path, "resume", &message))?;
    Ok(file)
}

fn parse_mcp_limits(path: &Path, value: &Value) -> Result<McpLimits> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid(path, "mcp", "expected an object"))?;
    let mut limits = McpLimits::default();
    for (field, value) in object {
        let (target, maximum) = match field.as_str() {
            "searchLimit" => (&mut limits.search_limit, 100),
            "timelineLimit" => (&mut limits.timeline_limit, 200),
            "eventMaxChars" => (&mut limits.event_max_chars, 20_000),
            "contextWindow" => (&mut limits.context_window, 20),
            _ => continue,
        };
        *target = value
            .as_u64()
            .and_then(|number| usize::try_from(number).ok())
            .filter(|number| (1..=maximum).contains(number))
            .ok_or_else(|| {
                invalid(
                    path,
                    &format!("mcp.{field}"),
                    &format!("expected a positive integer no greater than {maximum}"),
                )
            })?;
    }
    Ok(limits)
}

fn parse_token_pricing(value: &Value) -> std::result::Result<TokenPricingDocument, String> {
    let object = value
        .as_object()
        .ok_or("tokenPricing must be an object mapping model keys to pricing entries")?;
    for (key, value) in object {
        let field_error =
            |field: &str, message: &str| format!("tokenPricing.{key}.{field}: {message}");
        if !key.contains('/') || key.starts_with('/') || key.ends_with('/') {
            return Err(format!(
                "tokenPricing.{key}: key must use provider/model format"
            ));
        }
        let entry = value
            .as_object()
            .ok_or_else(|| format!("tokenPricing.{key}: must be an object"))?;
        let currency = entry
            .get("currency")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| {
                value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_alphabetic())
            });
        if currency.is_none() {
            return Err(field_error(
                "currency",
                "must be a three-letter ISO 4217 code",
            ));
        }
        for (field, required) in [
            ("inputPerMillion", true),
            ("outputPerMillion", true),
            ("reasoningPerMillion", false),
            ("cacheReadPerMillion", false),
            ("cacheWritePerMillion", false),
        ] {
            if required || entry.contains_key(field) {
                entry
                    .get(field)
                    .and_then(Value::as_f64)
                    .filter(|rate| rate.is_finite() && *rate >= 0.0)
                    .ok_or_else(|| field_error(field, "must be a finite non-negative number"))?;
            }
        }
        if let Some(value) = entry.get("sourceLabel") {
            value
                .as_str()
                .filter(|label| label.encode_utf16().count() <= 200)
                .ok_or_else(|| {
                    field_error("sourceLabel", "must be a string of at most 200 characters")
                })?;
        }
        if let Some(value) = entry.get("sourceUrl") {
            let url = value.as_str().and_then(|value| url::Url::parse(value).ok());
            if !url
                .as_ref()
                .is_some_and(|url| matches!(url.scheme(), "http" | "https"))
            {
                return Err(field_error(
                    "sourceUrl",
                    "must be an absolute http or https URL",
                ));
            }
        }
        if let Some(value) = entry.get("asOf") {
            let valid = value.as_str().is_some_and(|date| {
                date.len() == 10
                    && date.bytes().enumerate().all(|(index, byte)| {
                        if index == 4 || index == 7 {
                            byte == b'-'
                        } else {
                            byte.is_ascii_digit()
                        }
                    })
            });
            if !valid {
                return Err(field_error("asOf", "must use YYYY-MM-DD"));
            }
        }
    }
    serde_json::from_value(value.clone()).map_err(|error| format!("tokenPricing: {error}"))
}

fn parse_project_paths(value: &Value) -> std::result::Result<ProjectPaths, String> {
    let providers = value
        .as_object()
        .ok_or("expected an object of provider maps")?;
    let mut paths = ProjectPaths::new();
    for (provider, mapping) in providers {
        if !["opencode", "claude-code", "codex", "pi", "deepseek-harness"]
            .contains(&provider.as_str())
        {
            return Err(format!("unsupported provider {provider}"));
        }
        let entries = mapping
            .as_object()
            .ok_or_else(|| format!("{provider} must be an object of project paths"))?;
        let mut projects = BTreeMap::new();
        for (key, directory) in entries {
            if key.trim().is_empty() {
                return Err(format!("{provider} has an empty project key"));
            }
            let directory = directory
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| format!("{provider}.{key} must be a nonempty path string"))?;
            if !Path::new(directory).is_absolute() {
                return Err(format!("{provider}.{key} must be an absolute path"));
            }
            projects.insert(key.clone(), directory.to_owned());
        }
        paths.insert(provider.clone(), projects);
    }
    Ok(paths)
}

fn invalid(path: &Path, key: &str, message: &str) -> ConfigError {
    ConfigError(format!("config {}: {key}: {message}", path.display()))
}

fn path_value(path: &Path, key: &str, value: &Value) -> Result<PathBuf> {
    let text = value
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| invalid(path, key, "expected a nonempty path string"))?;
    Ok(PathBuf::from(text))
}

fn choose(
    cli: Option<PathBuf>,
    env_name: &str,
    file: &Option<PathBuf>,
    default: PathBuf,
) -> Result<PathBuf> {
    if let Some(cli) = cli {
        return Ok(cli);
    }
    if let Some(value) = env::var_os(env_name) {
        if value.is_empty() {
            return Err(ConfigError(format!("{env_name}: expected a nonempty path")));
        }
        return Ok(PathBuf::from(value));
    }
    Ok(file.clone().unwrap_or(default))
}

fn home_dir() -> Result<PathBuf> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    env::var_os(key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| ConfigError(format!("{key}: home directory is unavailable")))
}

fn default_state_dir(home: &Path) -> PathBuf {
    if cfg!(windows) {
        env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("agentsession-v3")
    } else {
        env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
            .join("agentsession-v3")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_paths_require_nonempty_strings() {
        let config = Path::new("config.json");
        assert!(path_value(config, "codexDir", &Value::Null).is_err());
        assert!(path_value(config, "codexDir", &Value::String("  ".into())).is_err());
        assert_eq!(
            path_value(config, "codexDir", &Value::String("source".into())).unwrap(),
            PathBuf::from("source")
        );
    }
}
