use super::{Core, Result, protocol};
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

const CACHE_LIMIT: usize = 256;

#[derive(PartialEq, Eq)]
struct CacheKey {
    scope: String,
    provider: String,
    session_id: String,
    revision: String,
    dependencies: String,
}

struct CacheEntry {
    key: CacheKey,
    stats: protocol::ProtocolListStats,
}

static CACHE: OnceLock<Mutex<VecDeque<CacheEntry>>> = OnceLock::new();

impl Core {
    pub fn protocol_list_stats(
        &self,
        provider: &str,
        session_id: &str,
    ) -> Result<protocol::ProtocolListStats> {
        let adapter = self.protocol_adapter(provider, session_id)?;
        // Only adapters with an exact selected-source stamp can reuse stats.
        let stamp_before = adapter.list_stats_revision(session_id)?;
        let key = stamp_before.as_ref().map(|stamp| CacheKey {
            scope: self.source_scope.clone(),
            provider: provider.into(),
            session_id: session_id.into(),
            revision: stamp.revision.clone(),
            dependencies: stamp.dependencies.clone(),
        });
        if let Some(key) = &key {
            let mut cache = CACHE
                .get_or_init(|| Mutex::new(VecDeque::new()))
                .lock()
                .expect("list stats cache");
            if let Some(position) = cache.iter().position(|entry| &entry.key == key) {
                let entry = cache.remove(position).expect("cache position exists");
                let stats = entry.stats.clone();
                cache.push_back(entry);
                return Ok(stats);
            }
        }
        let stats = adapter.protocol_bundle(session_id)?.list_stats();
        if stamp_before.is_some() && adapter.list_stats_revision(session_id)? != stamp_before {
            return Err(super::CoreError::SourceChanged);
        }
        if let Some(key) = key {
            let mut cache = CACHE
                .get_or_init(|| Mutex::new(VecDeque::new()))
                .lock()
                .expect("list stats cache");
            cache.push_back(CacheEntry {
                key,
                stats: stats.clone(),
            });
            if cache.len() > CACHE_LIMIT {
                cache.pop_front();
            }
        }
        Ok(stats)
    }
}
