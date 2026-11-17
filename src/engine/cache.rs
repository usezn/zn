use super::bounded::{batch_size, oldest_keys, WarnOnce, MAX_CACHE_ENTRIES, SWEEP_EVERY};
use crate::config::CachingConfig;
use dashmap::DashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

struct CacheEntry {
    result: String,
    expiry: Instant,
}

/// Tool Result Cache (Exact Match)
///
/// Holds at most 10,000 entries by default. Expired entries are removed on
/// insert (every `SWEEP_EVERY` new entries and whenever the cap is reached); if the cache is
/// still full, the entries that expire first are dropped.
pub struct ResultCache {
    /// agent_id:tool:args_hash -> Result
    cache: DashMap<String, CacheEntry>,
    config: CachingConfig,
    max_entries: usize,
    inserts: AtomicUsize,
    warned: WarnOnce,
}

impl ResultCache {
    pub fn new(config: CachingConfig) -> Self {
        Self::with_max_entries(config, MAX_CACHE_ENTRIES)
    }

    pub fn with_max_entries(config: CachingConfig, max_entries: usize) -> Self {
        Self {
            cache: DashMap::new(),
            config,
            max_entries: max_entries.max(1),
            inserts: AtomicUsize::new(0),
            warned: WarnOnce::new(),
        }
    }

    /// Called before a new key is added: removes expired entries and, if the
    /// cache is still full, the entries that expire first. The key being added
    /// is not in the map yet, so it is never the one dropped.
    fn make_room(&self, now: Instant) {
        let n = self.inserts.fetch_add(1, Ordering::Relaxed) + 1;
        let full = self.cache.len() >= self.max_entries;
        if !full && !n.is_multiple_of(SWEEP_EVERY) {
            return;
        }
        self.cache.retain(|_, e| e.expiry > now);
        if self.cache.len() >= self.max_entries {
            self.warned.warn("result cache", self.max_entries);
            let keys = oldest_keys(
                self.cache.iter().map(|e| (e.key().clone(), e.expiry)),
                batch_size(self.max_entries),
            );
            for k in keys {
                self.cache.remove(&k);
            }
        }
    }

    /// Try to get a cached result
    pub fn get(&self, agent_id: &str, tool_name: &str, arguments: &str) -> Option<String> {
        if !self.config.enabled {
            return None;
        }

        let key = self.make_key(agent_id, tool_name, arguments);
        if let Some(entry) = self.cache.get(&key) {
            if entry.expiry > Instant::now() {
                return Some(entry.result.clone());
            } else {
                // Remove expired entry
                drop(entry);
                self.cache.remove(&key);
            }
        }
        None
    }

    /// Store a result in cache
    pub fn set(&self, agent_id: &str, tool_name: &str, arguments: &str, result: String) {
        if !self.config.enabled {
            return;
        }

        let key = self.make_key(agent_id, tool_name, arguments);
        // A huge TTL must not overflow the clock; fall back to "expires now".
        let now = Instant::now();
        let expiry = now
            .checked_add(Duration::from_secs(self.config.ttl_seconds))
            .unwrap_or(now);
        if !self.cache.contains_key(&key) {
            self.make_room(now);
        }
        self.cache.insert(key, CacheEntry { result, expiry });
    }

    fn make_key(&self, agent_id: &str, tool_name: &str, arguments: &str) -> String {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();
        agent_id.hash(&mut hasher);
        tool_name.hash(&mut hasher);
        arguments.hash(&mut hasher);
        format!("{:x}", hasher.finish())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn cache(enabled: bool, ttl_seconds: u64) -> ResultCache {
        ResultCache::new(CachingConfig {
            enabled,
            ttl_seconds,
        })
    }

    #[test]
    fn huge_ttl_does_not_panic() {
        for ttl in [u64::MAX, i64::MAX as u64] {
            let c = cache(true, ttl);
            c.set("a", "t", "{}", "r".to_string());
        }
    }

    #[test]
    fn miss_on_empty_cache() {
        assert!(cache(true, 60).get("agent", "tool", "{}").is_none());
    }

    #[test]
    fn set_then_get_returns_result() {
        let c = cache(true, 60);
        c.set("agent", "tool", r#"{"a":1}"#, "ok".to_string());
        assert_eq!(c.get("agent", "tool", r#"{"a":1}"#).as_deref(), Some("ok"));
    }

    #[test]
    fn disabled_cache_stores_nothing() {
        let c = cache(false, 60);
        c.set("agent", "tool", "{}", "ok".to_string());
        assert!(c.get("agent", "tool", "{}").is_none());
        assert!(c.cache.is_empty());
    }

    #[test]
    fn keys_separate_agent_tool_and_arguments() {
        let c = cache(true, 60);
        c.set("agent-a", "tool", "{}", "a".to_string());
        assert!(c.get("agent-b", "tool", "{}").is_none());
        assert!(c.get("agent-a", "other", "{}").is_none());
        assert!(c.get("agent-a", "tool", "{\"x\":1}").is_none());
    }

    #[test]
    fn key_fields_do_not_run_together() {
        let c = cache(true, 60);
        c.set("ab", "c", "", "first".to_string());
        assert!(c.get("a", "bc", "").is_none());
    }

    #[test]
    fn empty_arguments_and_values_are_cached() {
        let c = cache(true, 60);
        c.set("", "", "", String::new());
        assert_eq!(c.get("", "", "").as_deref(), Some(""));
    }

    #[test]
    fn set_overwrites_previous_value() {
        let c = cache(true, 60);
        c.set("a", "t", "x", "old".to_string());
        c.set("a", "t", "x", "new".to_string());
        assert_eq!(c.get("a", "t", "x").as_deref(), Some("new"));
        assert_eq!(c.cache.len(), 1);
    }

    #[test]
    fn zero_ttl_entry_is_expired_and_evicted_on_read() {
        let c = cache(true, 0);
        c.set("a", "t", "x", "v".to_string());
        assert_eq!(c.cache.len(), 1);
        assert!(c.get("a", "t", "x").is_none());
        assert!(c.cache.is_empty(), "expired entry should be removed");
    }

    #[test]
    fn entry_expires_after_ttl() {
        let c = cache(true, 1);
        c.set("a", "t", "x", "v".to_string());
        assert!(c.get("a", "t", "x").is_some());
        std::thread::sleep(std::time::Duration::from_millis(1100));
        assert!(c.get("a", "t", "x").is_none());
    }

    #[tokio::test]
    async fn concurrent_writers_and_readers_are_consistent() {
        let c = Arc::new(cache(true, 60));
        let mut handles = Vec::new();
        for i in 0..16 {
            let c = Arc::clone(&c);
            handles.push(tokio::spawn(async move {
                let args = format!("{{\"n\":{i}}}");
                c.set("agent", "tool", &args, format!("result-{i}"));
                c.get("agent", "tool", &args)
            }));
        }
        for (i, h) in handles.into_iter().enumerate() {
            assert_eq!(h.await.unwrap(), Some(format!("result-{i}")));
        }
        assert_eq!(c.cache.len(), 16);
    }

    fn capped(ttl: u64, max: usize) -> ResultCache {
        ResultCache::with_max_entries(
            CachingConfig {
                enabled: true,
                ttl_seconds: ttl,
            },
            max,
        )
    }

    #[test]
    fn default_cap_is_ten_thousand_entries() {
        assert_eq!(cache(true, 60).max_entries, 10_000);
    }

    #[test]
    fn entry_cap_is_respected() {
        let c = capped(60, 100);
        for i in 0..5_000 {
            c.set(&format!("agent-{i}"), "t", "{}", "r".to_string());
            assert!(c.cache.len() <= 100);
        }
    }

    #[test]
    fn oldest_entries_are_dropped_first_and_the_new_one_is_kept() {
        let c = capped(60, 10);
        for i in 0..10 {
            c.set(&format!("a-{i}"), "t", "{}", format!("r{i}"));
        }
        c.set("new", "t", "{}", "fresh".to_string());
        assert_eq!(c.get("new", "t", "{}").as_deref(), Some("fresh"));
        assert!(c.get("a-0", "t", "{}").is_none(), "oldest is dropped");
        assert_eq!(c.get("a-9", "t", "{}").as_deref(), Some("r9"));
    }

    #[test]
    fn expired_entries_are_removed_on_insert_without_being_read() {
        let c = capped(0, 1_000);
        for i in 0..SWEEP_EVERY {
            c.set(&format!("a-{i}"), "t", "{}", "r".to_string());
        }
        // Every entry has a zero TTL, so the periodic sweep leaves almost none.
        assert!(c.cache.len() < SWEEP_EVERY);
    }

    #[test]
    fn expired_entries_make_room_before_live_ones_are_dropped() {
        let c = capped(60, 4);
        for i in 0..4 {
            c.set(&format!("a-{i}"), "t", "{}", "r".to_string());
        }
        // Expire a-3 (the newest) by hand: the sweep must remove it, not a-0.
        let past = Instant::now() - Duration::from_secs(1);
        for mut e in c.cache.iter_mut() {
            if e.result == "r" {
                e.expiry = past;
            }
        }
        c.set("live", "t", "{}", "live".to_string());
        assert_eq!(c.get("live", "t", "{}").as_deref(), Some("live"));
        assert_eq!(c.cache.len(), 1);
    }
}
