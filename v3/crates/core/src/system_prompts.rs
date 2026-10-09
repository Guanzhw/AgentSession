//! Source-backed prompt evidence. Current files are candidates, not a claim
//! about the exact historical prompt used by a session.
use crate::SessionSummary;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPromptEvidence {
    pub session_id: String,
    pub mode: String,
    pub hidden_prompt_stored: bool,
    pub selected_agent: Option<String>,
    pub first_user_message: Option<serde_json::Value>,
    pub note: String,
    pub sections: Vec<PromptSection>,
    pub diagnostics: Vec<PromptDiagnostic>,
}

#[derive(Debug, Serialize)]
pub struct PromptSection {
    pub title: String,
    pub note: String,
    pub items: Vec<PromptItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptItem {
    pub kind: String,
    pub title: String,
    pub preview: String,
    pub content: String,
    pub source: String,
    pub source_path: Option<String>,
    pub source_metadata: Option<serde_json::Value>,
    pub provenance: &'static str,
    pub resolution: &'static str,
    pub time: u64,
}

#[derive(Debug, Serialize)]
pub struct PromptDiagnostic {
    pub code: &'static str,
    pub message: String,
    pub source: Option<String>,
}

impl SystemPromptEvidence {
    pub(crate) fn new(summary: &SessionSummary, mode: &str) -> Self {
        Self {
            session_id: summary.session.session_id.clone(),
            mode: mode.into(),
            hidden_prompt_stored: false,
            selected_agent: None,
            first_user_message: None,
            note: "Recorded prompt text and currently resolvable local instruction sources are shown with separate provenance. Current files may differ from the session's historical runtime.".into(),
            sections: Vec::new(),
            diagnostics: vec![PromptDiagnostic {
                code: "hidden_prompt_unavailable",
                message: "Provider-hidden or unrecorded prompt text cannot be recovered from local session data.".into(),
                source: None,
            }],
        }
    }

    pub(crate) fn recorded(&mut self, title: &str, content: String, source: String, time: u64) {
        self.recorded_with_metadata(title, content, source, time, None);
    }

    pub(crate) fn recorded_with_metadata(
        &mut self,
        title: &str,
        content: String,
        source: String,
        time: u64,
        source_metadata: Option<serde_json::Value>,
    ) {
        if content.is_empty() {
            return;
        }
        self.hidden_prompt_stored = true;
        self.section_mut(
            "Stored System Prompt",
            "Prompt text explicitly persisted with this session.",
        )
        .items
        .push(PromptItem {
            kind: "system-prompt".into(),
            title: title.into(),
            preview: preview(&content),
            content,
            source,
            source_path: None,
            source_metadata,
            provenance: "recorded",
            resolution: "resolved",
            time,
        });
    }

    pub(crate) fn current_files(&mut self, summary: &SessionSummary, names: &[&str]) {
        let Some(directory) = summary.directory.as_deref() else {
            self.diagnostics.push(PromptDiagnostic {
                code: "session_directory_unavailable",
                message: "Session source has no recorded working directory for local instruction resolution.".into(),
                source: None,
            });
            return;
        };
        let mut current = PathBuf::from(directory);
        if !current.is_absolute() {
            self.diagnostics.push(PromptDiagnostic {
                code: "session_directory_unavailable",
                message: "Recorded working directory is not absolute.".into(),
                source: Some(directory.into()),
            });
            return;
        }
        let section_count = self
            .sections
            .iter()
            .find(|section| section.title == "Current Local Instructions")
            .map_or(0, |section| section.items.len());
        for _ in 0..64 {
            for name in names {
                let path = current.join(name);
                if path.is_file() {
                    self.current_file(&path);
                }
            }
            if !current.pop() {
                break;
            }
        }
        if self
            .sections
            .iter()
            .find(|section| section.title == "Current Local Instructions")
            .map_or(0, |section| section.items.len())
            == section_count
        {
            self.diagnostics.push(PromptDiagnostic {
                code: "local_instruction_sources_unavailable",
                message: "No matching instruction file is currently resolvable along the recorded working-directory ancestry.".into(),
                source: Some(directory.into()),
            });
        }
    }

    pub(crate) fn current_file(&mut self, path: &Path) {
        const MAX_BYTES: u64 = 1024 * 1024;
        let source = path.to_string_lossy().into_owned();
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) => {
                self.diagnostics.push(PromptDiagnostic {
                    code: "instruction_unreadable",
                    message: error.to_string(),
                    source: Some(source),
                });
                return;
            }
        };
        if metadata.len() > MAX_BYTES {
            self.diagnostics.push(PromptDiagnostic {
                code: "instruction_too_large",
                message: "Instruction file exceeds the 1 MiB evidence limit.".into(),
                source: Some(source),
            });
            return;
        }
        let content = match fs::read_to_string(path) {
            Ok(content) => content,
            Err(error) => {
                self.diagnostics.push(PromptDiagnostic {
                    code: "instruction_unreadable",
                    message: error.to_string(),
                    source: Some(source),
                });
                return;
            }
        };
        let time = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|value| value.as_millis() as u64)
            .unwrap_or(0);
        self.section_mut("Current Local Instructions", "Files currently resolvable from the recorded working directory; historical use is not proven.")
            .items.push(PromptItem {
                kind: "instruction".into(),
                title: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                preview: preview(&content), content, source: source.clone(), source_path: Some(source),
                source_metadata: None, provenance: "current-local", resolution: "resolved", time,
            });
    }

    fn section_mut(&mut self, title: &str, note: &str) -> &mut PromptSection {
        if let Some(index) = self
            .sections
            .iter()
            .position(|section| section.title == title)
        {
            return &mut self.sections[index];
        }
        self.sections.push(PromptSection {
            title: title.into(),
            note: note.into(),
            items: Vec::new(),
        });
        self.sections.last_mut().unwrap()
    }
}

fn preview(content: &str) -> String {
    let compact = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = compact.chars();
    let head: String = chars.by_ref().take(500).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}
