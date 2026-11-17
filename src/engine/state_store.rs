//! Key-value store that WASM policies share through `zn_state_set` and
//! `zn_state_get`. It has a byte cap: when a write would pass it, the entries
//! used the longest ago are dropped (never the one being written), so a policy
//! that writes a new key on every call cannot grow memory for ever.

use super::bounded::{WarnOnce, MAX_STATE_STORE_BYTES};
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

struct Entry {
    value: String,
    stamp: u64,
}

#[derive(Default)]
struct Inner {
    map: HashMap<String, Entry>,
    /// stamp -> key, oldest first
    order: BTreeMap<u64, String>,
    bytes: usize,
    next_stamp: u64,
}

impl Inner {
    fn cost(key: &str, value: &str) -> usize {
        key.len() + value.len()
    }

    fn stamp(&mut self) -> u64 {
        self.next_stamp += 1;
        self.next_stamp
    }
}

pub struct StateStore {
    inner: Mutex<Inner>,
    max_bytes: usize,
    warned: WarnOnce,
}

impl Default for StateStore {
    fn default() -> Self {
        Self::new()
    }
}

impl StateStore {
    pub fn new() -> Self {
        Self::with_max_bytes(MAX_STATE_STORE_BYTES)
    }

    pub fn with_max_bytes(max_bytes: usize) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            max_bytes,
            warned: WarnOnce::new(),
        }
    }

    /// Store a value. A single entry larger than the cap is not stored.
    pub fn insert(&self, key: String, value: String) {
        let cost = Inner::cost(&key, &value);
        if cost > self.max_bytes {
            self.warned.warn("policy state store", self.max_bytes);
            return;
        }
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = g.map.remove(&key) {
            g.order.remove(&old.stamp);
            g.bytes -= Inner::cost(&key, &old.value);
        }
        while g.bytes + cost > self.max_bytes {
            let Some((&stamp, _)) = g.order.iter().next() else {
                break;
            };
            if let Some(oldest) = g.order.remove(&stamp) {
                if let Some(e) = g.map.remove(&oldest) {
                    g.bytes -= Inner::cost(&oldest, &e.value);
                }
            }
            self.warned.warn("policy state store", self.max_bytes);
        }
        let stamp = g.stamp();
        g.bytes += cost;
        g.order.insert(stamp, key.clone());
        g.map.insert(key, Entry { value, stamp });
    }

    /// Read a value and mark it as recently used.
    pub fn get(&self, key: &str) -> Option<String> {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let new_stamp = g.stamp();
        let old_stamp = {
            let e = g.map.get_mut(key)?;
            let old = e.stamp;
            e.stamp = new_stamp;
            old
        };
        g.order.remove(&old_stamp);
        g.order.insert(new_stamp, key.to_string());
        g.map.get(key).map(|e| e.value.clone())
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.lock().unwrap().map.len()
    }

    #[cfg(test)]
    fn bytes(&self) -> usize {
        self.inner.lock().unwrap().bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_and_reads_back() {
        let s = StateStore::new();
        s.insert("k".into(), "v".into());
        assert_eq!(s.get("k").as_deref(), Some("v"));
        assert!(s.get("missing").is_none());
    }

    #[test]
    fn overwrite_replaces_value_and_keeps_byte_count_exact() {
        let s = StateStore::new();
        s.insert("k".into(), "long-value".into());
        s.insert("k".into(), "v".into());
        assert_eq!(s.get("k").as_deref(), Some("v"));
        assert_eq!(s.len(), 1);
        assert_eq!(s.bytes(), 2);
    }

    #[test]
    fn byte_cap_is_respected_and_oldest_entries_go_first() {
        // Each entry costs 2 bytes ("a" + "1"); room for 3.
        let s = StateStore::with_max_bytes(6);
        for k in ["a", "b", "c", "d", "e"] {
            s.insert(k.into(), "1".into());
            assert!(s.bytes() <= 6);
        }
        assert_eq!(s.len(), 3);
        assert!(s.get("a").is_none());
        assert!(s.get("b").is_none());
        assert!(s.get("c").is_some());
        assert!(s.get("d").is_some());
        assert!(s.get("e").is_some());
    }

    #[test]
    fn reading_an_entry_protects_it_from_eviction() {
        let s = StateStore::with_max_bytes(6);
        s.insert("a".into(), "1".into());
        s.insert("b".into(), "1".into());
        s.insert("c".into(), "1".into());
        assert!(s.get("a").is_some()); // "a" is now the most recently used
        s.insert("d".into(), "1".into());
        assert!(s.get("a").is_some());
        assert!(s.get("b").is_none(), "least recently used entry is dropped");
    }

    #[test]
    fn the_entry_being_written_is_never_evicted() {
        let s = StateStore::with_max_bytes(6);
        s.insert("a".into(), "1".into());
        s.insert("b".into(), "1".into());
        s.insert("c".into(), "1".into());
        s.insert("new".into(), "12".into()); // costs 5: needs room for it
        assert_eq!(s.get("new").as_deref(), Some("12"));
    }

    #[test]
    fn an_entry_bigger_than_the_cap_is_not_stored() {
        let s = StateStore::with_max_bytes(4);
        s.insert("a".into(), "1".into());
        s.insert("big".into(), "123456".into());
        assert!(s.get("big").is_none());
        assert_eq!(s.get("a").as_deref(), Some("1"), "others are left alone");
    }

    #[test]
    fn a_flood_of_distinct_keys_stays_under_the_cap() {
        let s = StateStore::with_max_bytes(1_000);
        for i in 0..10_000 {
            s.insert(format!("key-{i}"), "x".repeat(10));
        }
        assert!(s.bytes() <= 1_000);
        assert_ne!(s.len(), 0);
    }
}
