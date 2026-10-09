use std::env;
use std::path::{Path, PathBuf};

pub(super) fn app_data_dir(home: &Path, name: &str) -> Option<PathBuf> {
    if cfg!(windows) {
        Some(
            env::var_os("APPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("AppData").join("Roaming"))
                .join(name),
        )
    } else if cfg!(target_os = "macos") {
        Some(home.join("Library").join("Application Support").join(name))
    } else {
        None
    }
}

pub(super) fn probe(candidates: &[Option<PathBuf>], fallback: PathBuf) -> PathBuf {
    candidates
        .iter()
        .flatten()
        .find(|path| path.exists())
        .cloned()
        .unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_probe_uses_existing_candidate_then_stable_fallback() {
        let present = env::current_exe().unwrap();
        let missing = present.with_extension("missing-provider-root");
        let fallback = PathBuf::from("fallback-provider-root");
        assert_eq!(
            probe(
                &[Some(missing.clone()), Some(present.clone())],
                fallback.clone()
            ),
            present
        );
        assert_eq!(probe(&[Some(missing)], fallback.clone()), fallback);
    }
}
