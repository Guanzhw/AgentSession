//! Viewer-owned metadata. Provider files and the derived catalog are never mutated here.
use crate::{Core, CoreError, ReaderBootstrap, Result, SessionSummary};
use rusqlite::{
    Connection, OptionalExtension,
    backup::{Backup, StepResult},
    params,
};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const COLUMNS: [&str; 9] = [
    "provider",
    "session_id",
    "custom_title",
    "starred",
    "deleted",
    "permanent",
    "time_starred",
    "time_deleted",
    "time_renamed",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerMeta {
    pub provider: String,
    pub session_id: String,
    pub custom_title: Option<String>,
    pub starred: bool,
    pub deleted: bool,
    pub permanent: bool,
    pub time_starred: Option<i64>,
    pub time_deleted: Option<i64>,
    pub time_renamed: Option<i64>,
}

fn storage(error: impl std::fmt::Display) -> CoreError {
    CoreError::Storage(format!("Viewer metadata: {error}"))
}

fn open(path: &Path, create: bool) -> Result<Option<Connection>> {
    if !path.exists() && !create {
        return Ok(None);
    }
    if create {
        std::fs::create_dir_all(path.parent().expect("metadata path has parent"))
            .map_err(|error| storage(error))?;
    }
    let db = Connection::open_with_flags(
        path,
        if create {
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
        } else {
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
        },
    )
    .map_err(storage)?;
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta')",
            [],
            |row| row.get(0),
        )
        .map_err(storage)?;
    if !exists {
        if create {
            db.execute_batch(
                "CREATE TABLE session_meta (
                provider TEXT NOT NULL DEFAULT 'opencode', session_id TEXT NOT NULL,
                custom_title TEXT, starred INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0,
                permanent INTEGER DEFAULT 0, time_starred INTEGER, time_deleted INTEGER,
                time_renamed INTEGER, PRIMARY KEY(provider, session_id))",
            )
            .map_err(storage)?;
        }
        return Ok(Some(db));
    }
    let mut statement = db
        .prepare("PRAGMA table_info(session_meta)")
        .map_err(storage)?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get(1))
        .map_err(storage)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(storage)?;
    if COLUMNS
        .iter()
        .any(|column| !columns.iter().any(|actual| actual == column))
    {
        return Err(storage(
            "session_meta schema is incompatible; explicit migration is required",
        ));
    }
    drop(statement);
    Ok(Some(db))
}

fn read(db: &Connection, provider: &str, session_id: &str) -> Result<Option<ViewerMeta>> {
    db.query_row(
        "SELECT custom_title,starred,deleted,permanent,time_starred,time_deleted,time_renamed
        FROM session_meta WHERE provider=?1 AND session_id=?2",
        params![provider, session_id],
        |row| {
            Ok(ViewerMeta {
                provider: provider.into(),
                session_id: session_id.into(),
                custom_title: row.get(0)?,
                starred: row.get::<_, i64>(1)? != 0,
                deleted: row.get::<_, i64>(2)? != 0,
                permanent: row.get::<_, i64>(3)? != 0,
                time_starred: row.get(4)?,
                time_deleted: row.get(5)?,
                time_renamed: row.get(6)?,
            })
        },
    )
    .optional()
    .map_err(storage)
}

fn valid_key(provider: &str, session_id: &str) -> Result<()> {
    if !super::PROVIDERS.contains(&provider)
        || session_id.is_empty()
        || session_id.len() > 200
        || session_id.chars().any(|ch| matches!(ch, '/' | '\\' | '\0'))
    {
        return Err(CoreError::InvalidInput(
            "provider and canonical session ID are required".into(),
        ));
    }
    Ok(())
}

impl Core {
    fn meta_path(&self) -> std::path::PathBuf {
        self.config
            .meta_dir
            .join("scopes")
            .join(&self.source_scope)
            .join("meta.db")
    }

    /// Copy the complete 2.0 Viewer database into this source scope. The old
    /// database remains the rollback copy, including retired rows and v1 index.
    pub fn import_viewer_metadata(&self, source: &Path) -> Result<()> {
        let source_db = open(source, false)?
            .ok_or_else(|| storage(format!("source {} does not exist", source.display())))?;
        let has_meta: bool = source_db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta')",
                [],
                |row| row.get(0),
            )
            .map_err(storage)?;
        if !has_meta {
            return Err(storage("source has no session_meta table"));
        }
        let check: String = source_db
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(storage)?;
        if check != "ok" {
            return Err(storage(format!("source quick_check failed: {check}")));
        }

        let target = self.meta_path();
        if target.exists() {
            return Err(storage(format!(
                "target {} already exists",
                target.display()
            )));
        }
        let parent = target.parent().expect("metadata path has parent");
        std::fs::create_dir_all(parent)
            .map_err(|error| storage(format!("create scope: {error}")))?;
        let staging = tempfile::tempdir_in(parent)
            .map_err(|error| storage(format!("create staging: {error}")))?;
        let stage_db = staging.path().join("meta.db");
        {
            let mut dest = Connection::open(&stage_db)
                .map_err(|error| storage(format!("open staging: {error}")))?;
            let backup = Backup::new(&source_db, &mut dest)
                .map_err(|error| storage(format!("start backup: {error}")))?;
            let deadline = Instant::now() + Duration::from_secs(120);
            loop {
                match backup
                    .step(512)
                    .map_err(|error| storage(format!("backup: {error}")))?
                {
                    StepResult::Done => break,
                    StepResult::More | StepResult::Busy | StepResult::Locked => {
                        if Instant::now() >= deadline {
                            return Err(storage("backup timed out before publication"));
                        }
                        std::thread::sleep(Duration::from_millis(25));
                    }
                    _ => return Err(storage("unsupported SQLite backup step result")),
                }
            }
            drop(backup);
            // Keep the published snapshot self-contained even when the source
            // uses WAL; its live journal files remain untouched.
            dest.pragma_update(None, "journal_mode", "DELETE")
                .map_err(|error| storage(format!("finalize staging: {error}")))?;
        }
        // Check the staged copy before its exclusive publication. Existing
        // user state must never be replaced, even if another process won a race.
        open(&stage_db, false)?;
        let staged = std::fs::OpenOptions::new()
            .write(true)
            .open(&stage_db)
            .map_err(|error| storage(format!("open staged file: {error}")))?;
        staged
            .sync_all()
            .map_err(|error| storage(format!("sync staged file: {error}")))?;
        drop(staged);
        std::fs::hard_link(&stage_db, &target).map_err(|error| {
            if target.exists() {
                storage(format!("target {} already exists", target.display()))
            } else {
                storage(format!("publish staged file: {error}"))
            }
        })?;
        Ok(())
    }

    pub(crate) fn viewer_metadata(&self) -> Result<HashMap<(String, String), ViewerMeta>> {
        let Some(db) = open(&self.meta_path(), false)? else {
            return Ok(HashMap::new());
        };
        let mut statement = db
            .prepare(
                "SELECT provider,session_id,custom_title,starred,deleted,permanent,
            time_starred,time_deleted,time_renamed FROM session_meta",
            )
            .map_err(storage)?;
        let rows = statement
            .query_map([], |row| {
                Ok(ViewerMeta {
                    provider: row.get(0)?,
                    session_id: row.get(1)?,
                    custom_title: row.get(2)?,
                    starred: row.get::<_, i64>(3)? != 0,
                    deleted: row.get::<_, i64>(4)? != 0,
                    permanent: row.get::<_, i64>(5)? != 0,
                    time_starred: row.get(6)?,
                    time_deleted: row.get(7)?,
                    time_renamed: row.get(8)?,
                })
            })
            .map_err(storage)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(storage)?;
        Ok(rows
            .into_iter()
            .map(|row| ((row.provider.clone(), row.session_id.clone()), row))
            .collect())
    }

    pub fn viewer_meta(&self, provider: &str, session_id: &str) -> Result<Option<ViewerMeta>> {
        valid_key(provider, session_id)?;
        match open(&self.meta_path(), false)? {
            Some(db) => read(&db, provider, session_id),
            None => Ok(None),
        }
    }

    pub fn viewer_meta_list(&self, provider: &str) -> Result<Vec<ViewerMeta>> {
        if !super::PROVIDERS.contains(&provider) {
            return Err(CoreError::InvalidInput("unknown provider".into()));
        }
        let mut rows: Vec<_> = self
            .viewer_metadata()?
            .into_values()
            .filter(|row| row.provider == provider)
            .collect();
        rows.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        Ok(rows)
    }

    pub fn viewer_reader_bootstrap(
        &self,
        provider: &str,
        session_id: &str,
    ) -> Result<ReaderBootstrap> {
        self.viewer_reader_bootstrap_at(
            provider,
            session_id,
            crate::ReaderBootstrapQuery::default(),
        )
    }

    pub fn viewer_reader_bootstrap_at(
        &self,
        provider: &str,
        session_id: &str,
        query: crate::ReaderBootstrapQuery,
    ) -> Result<ReaderBootstrap> {
        let mut page = self.reader_bootstrap_at(provider, session_id, query)?;
        if let Some(title) = self
            .viewer_meta(provider, session_id)?
            .and_then(|row| row.custom_title)
        {
            page.session.title = title;
        }
        Ok(page)
    }

    pub fn viewer_sessions(&self, provider: &str) -> Result<Vec<SessionSummary>> {
        self.visible_sessions(provider, self.sessions(provider)?)
    }

    pub(crate) fn visible_sessions(
        &self,
        provider: &str,
        mut rows: Vec<SessionSummary>,
    ) -> Result<Vec<SessionSummary>> {
        let Some(db) = open(&self.meta_path(), false)? else {
            return Ok(rows);
        };
        let mut statement = db.prepare("SELECT session_id,custom_title,deleted,permanent FROM session_meta WHERE provider=?1")
            .map_err(storage)?;
        let metadata = statement
            .query_map([provider], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(storage)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(storage)?;
        let by_id: HashMap<_, _> = metadata
            .into_iter()
            .map(|(id, title, deleted, permanent)| (id, (title, deleted != 0 || permanent != 0)))
            .collect();
        rows.retain_mut(|row| match by_id.get(&row.session.session_id) {
            Some((_, true)) => false,
            Some((Some(title), false)) => {
                row.title = title.clone();
                true
            }
            _ => true,
        });
        Ok(rows)
    }

    pub fn viewer_trash(&self, provider: &str) -> Result<Vec<ViewerMeta>> {
        if !super::PROVIDERS.contains(&provider) {
            return Err(CoreError::InvalidInput("unknown provider".into()));
        }
        let Some(db) = open(&self.meta_path(), false)? else {
            return Ok(Vec::new());
        };
        let mut statement = db.prepare("SELECT session_id FROM session_meta WHERE provider=?1 AND deleted=1 AND permanent=0")
            .map_err(storage)?;
        let ids = statement
            .query_map([provider], |row| row.get::<_, String>(0))
            .map_err(storage)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(storage)?;
        ids.iter()
            .map(|id| read(&db, provider, id).map(|row| row.expect("selected metadata row")))
            .collect()
    }

    pub fn viewer_mutate(
        &self,
        provider: &str,
        session_id: &str,
        action: &str,
        title: Option<&str>,
    ) -> Result<ViewerMeta> {
        valid_key(provider, session_id)?;
        if !matches!(
            action,
            "star" | "rename" | "delete" | "restore" | "permanent-delete"
        ) {
            return Err(CoreError::InvalidInput(
                "unknown Viewer metadata action".into(),
            ));
        }
        let normalized_title = if action == "rename" {
            let value = title
                .ok_or_else(|| CoreError::InvalidInput("title is required".into()))?
                .trim();
            if value.is_empty() || value.chars().count() > 500 {
                return Err(CoreError::InvalidInput(
                    "title must contain 1–500 characters".into(),
                ));
            }
            Some(value)
        } else {
            None
        };
        let prior = self.viewer_meta(provider, session_id)?;
        if !matches!(action, "restore" | "permanent-delete")
            || !prior.as_ref().is_some_and(|row| row.deleted)
        {
            self.load_session(provider, session_id)?;
        }
        self.write_viewer_metadata(provider, session_id, action, normalized_title)
    }

    // Callers validate keys, actions, titles, and source availability before writing.
    // Always read mutable Viewer state inside the transaction.
    fn write_viewer_metadata(
        &self,
        provider: &str,
        session_id: &str,
        action: &str,
        normalized_title: Option<&str>,
    ) -> Result<ViewerMeta> {
        let mut db = open(&self.meta_path(), true)?.expect("create opens metadata database");
        let tx = db.transaction().map_err(storage)?;
        tx.execute(
            "INSERT OR IGNORE INTO session_meta(provider,session_id) VALUES (?1,?2)",
            params![provider, session_id],
        )
        .map_err(storage)?;
        let current = read(&tx, provider, session_id)?.expect("inserted metadata row");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        match action {
            "star" => {
                tx.execute("UPDATE session_meta SET starred=?3,time_starred=?4 WHERE provider=?1 AND session_id=?2",
                params![provider,session_id, !current.starred, if current.starred {None} else {Some(now)}]).map_err(storage)?;
            }
            "rename" => {
                tx.execute("UPDATE session_meta SET custom_title=?3,time_renamed=?4 WHERE provider=?1 AND session_id=?2",
                params![provider,session_id,normalized_title,now]).map_err(storage)?;
            }
            "delete" => {
                tx.execute("UPDATE session_meta SET deleted=1,time_deleted=?3 WHERE provider=?1 AND session_id=?2",
                params![provider,session_id,now]).map_err(storage)?;
            }
            "restore" => {
                if current.permanent {
                    return Err(CoreError::InvalidInput(
                        "permanently excluded session cannot be restored".into(),
                    ));
                }
                tx.execute("UPDATE session_meta SET deleted=0,time_deleted=NULL WHERE provider=?1 AND session_id=?2",
                params![provider,session_id]).map_err(storage)?;
            }
            "permanent-delete" => {
                tx.execute("UPDATE session_meta SET deleted=1,permanent=1,time_deleted=COALESCE(time_deleted,?3) WHERE provider=?1 AND session_id=?2",
                params![provider,session_id,now]).map_err(storage)?;
            }
            _ => unreachable!(),
        }
        let result = read(&tx, provider, session_id)?.expect("updated metadata row");
        tx.commit().map_err(storage)?;
        Ok(result)
    }

    pub fn viewer_batch(&self, provider: &str, ids: &[String], action: &str) -> Result<usize> {
        if ids.is_empty()
            || ids.len() > 100
            || !matches!(
                action,
                "delete" | "restore" | "permanent-delete" | "star" | "unstar"
            )
        {
            return Err(CoreError::InvalidInput(
                "batch requires 1–100 IDs and a supported action".into(),
            ));
        }
        if ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len() {
            return Err(CoreError::InvalidInput("batch IDs must be distinct".into()));
        }
        for id in ids {
            valid_key(provider, id)?;
            let current = self.viewer_meta(provider, id)?;
            if !matches!(action, "restore" | "permanent-delete")
                || !current.as_ref().is_some_and(|row| row.deleted)
            {
                self.load_session(provider, id)?;
            }
            if action == "restore" && current.as_ref().is_some_and(|row| row.permanent) {
                return Err(CoreError::InvalidInput(
                    "permanently excluded session cannot be restored".into(),
                ));
            }
        }
        if matches!(action, "star" | "unstar") {
            let mut db = open(&self.meta_path(), true)?.expect("create opens metadata database");
            let tx = db.transaction().map_err(storage)?;
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;
            for id in ids {
                tx.execute(
                    "INSERT OR IGNORE INTO session_meta(provider,session_id) VALUES (?1,?2)",
                    params![provider, id],
                )
                .map_err(storage)?;
                if action == "star" {
                    tx.execute(
                        "UPDATE session_meta SET starred=1,
                        time_starred=CASE WHEN starred=0 OR time_starred IS NULL THEN ?3 ELSE time_starred END
                        WHERE provider=?1 AND session_id=?2",
                        params![provider, id, now],
                    )
                    .map_err(storage)?;
                } else {
                    tx.execute(
                        "UPDATE session_meta SET starred=0,time_starred=NULL
                        WHERE provider=?1 AND session_id=?2",
                        params![provider, id],
                    )
                    .map_err(storage)?;
                }
            }
            tx.commit().map_err(storage)?;
        } else {
            for id in ids {
                self.write_viewer_metadata(provider, id, action, None)?;
            }
        }
        Ok(ids.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SourceConfig;
    use std::path::PathBuf;

    #[test]
    fn preflighted_restore_checks_current_permanent_state_in_the_write_transaction() {
        let state = tempfile::tempdir().unwrap();
        let core = Core::new(SourceConfig {
            codex_dir: state.path().join("missing-codex"),
            opencode_db: state.path().join("missing-opencode.db"),
            claude_dir: state.path().join("missing-claude"),
            pi_dir: state.path().join("missing-pi"),
            dsh_dir: state.path().join("missing-dsh"),
            meta_dir: state.path().join("meta"),
            index_dir: state.path().join("index"),
            cache_dir: state.path().join("cache"),
        })
        .unwrap();
        let db = open(&core.meta_path(), true).unwrap().unwrap();
        db.execute(
            "INSERT INTO session_meta(provider,session_id,deleted) VALUES ('pi','metadata-only',1)",
            [],
        )
        .unwrap();
        let preflight = core.viewer_meta("pi", "metadata-only").unwrap().unwrap();
        assert!(preflight.deleted && !preflight.permanent);
        db.execute(
            "UPDATE session_meta SET permanent=1 WHERE provider='pi' AND session_id='metadata-only'",
            [],
        )
        .unwrap();
        let error = core
            .write_viewer_metadata("pi", "metadata-only", "restore", None)
            .unwrap_err();
        assert!(matches!(error, CoreError::InvalidInput(_)));
        let current = core.viewer_meta("pi", "metadata-only").unwrap().unwrap();
        assert!(current.deleted && current.permanent);
    }

    #[test]
    fn shared_state_directory_keeps_same_canonical_id_in_separate_source_scopes() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join("test/fixtures/v3-source-scope");
        let state = tempfile::tempdir().unwrap();
        let config = |side: &str| SourceConfig {
            codex_dir: fixture.join(side),
            opencode_db: state.path().join("missing-opencode.db"),
            claude_dir: state.path().join("missing-claude"),
            pi_dir: state.path().join("missing-pi"),
            dsh_dir: state.path().join("missing-dsh"),
            meta_dir: state.path().join("meta"),
            index_dir: state.path().join("index"),
            cache_dir: state.path().join("cache"),
        };
        let left = Core::new(config("left")).unwrap();
        let right = Core::new(config("right")).unwrap();
        assert_ne!(left.source_scope(), right.source_scope());
        let id = "11111111-1111-4111-8111-111111111111";
        left.viewer_mutate("codex", id, "rename", Some("Left-only title"))
            .unwrap();
        assert!(right.viewer_meta("codex", id).unwrap().is_none());
        right.viewer_mutate("codex", id, "delete", None).unwrap();
        assert!(
            left.viewer_sessions("codex")
                .unwrap()
                .iter()
                .any(|row| row.session.session_id == id)
        );
        assert!(
            !right
                .viewer_sessions("codex")
                .unwrap()
                .iter()
                .any(|row| row.session.session_id == id)
        );
    }

    #[test]
    fn source_scope_does_not_change_when_a_configured_directory_first_appears() {
        let state = tempfile::tempdir().unwrap();
        let codex_dir = state.path().join("later-codex");
        let config = SourceConfig {
            codex_dir: codex_dir.clone(),
            opencode_db: state.path().join("missing-opencode.db"),
            claude_dir: state.path().join("missing-claude"),
            pi_dir: state.path().join("missing-pi"),
            dsh_dir: state.path().join("missing-dsh"),
            meta_dir: state.path().join("meta"),
            index_dir: state.path().join("index"),
            cache_dir: state.path().join("cache"),
        };
        let before = Core::new(config.clone()).unwrap();
        std::fs::create_dir(&codex_dir).unwrap();
        let after = Core::new(config).unwrap();
        assert_eq!(before.source_scope(), after.source_scope());
    }
}
