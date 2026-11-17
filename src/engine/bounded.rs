//! Small helpers shared by the per-agent structures that have a size cap.
//!
//! Agent ids come from the message and are not authenticated, so every map that
//! is keyed by agent id (or holds one entry per call) needs a cap, or a client
//! that sends a new id on every call makes it grow for ever. The rule used
//! everywhere: when a cap is reached, drop the entries seen the longest ago, never
//! the entry of the call being handled, and log one warning per structure.

use std::sync::atomic::{AtomicBool, Ordering};

/// Default cap on the agents tracked by the loop breaker.
pub const MAX_LOOP_BREAKER_AGENTS: usize = 10_000;
/// Default cap on the actions kept per agent by the loop breaker.
pub const MIN_LOOP_BREAKER_ACTIONS_PER_AGENT: usize = 1_000;
/// Default cap on the agents tracked by the reputation system.
pub const MAX_REPUTATION_AGENTS: usize = 10_000;
/// Default cap on the entries of the tool result cache.
pub const MAX_CACHE_ENTRIES: usize = 10_000;
/// Default cap on the actions waiting for approval.
pub const MAX_PENDING_ACTIONS: usize = 1_000;
/// Default cap on the policy state store (bytes of keys plus values).
pub const MAX_STATE_STORE_BYTES: usize = 16 * 1024 * 1024;

/// An expired-entry sweep runs after this many new insertions even if the cap
/// is not reached, so idle entries do not wait for a full structure.
pub const SWEEP_EVERY: usize = 1_024;

/// Logs a warning the first time a cap is hit, and never again.
pub struct WarnOnce(AtomicBool);

impl WarnOnce {
    pub const fn new() -> Self {
        Self(AtomicBool::new(false))
    }

    pub fn warn(&self, what: &str, cap: usize) {
        if !self.0.swap(true, Ordering::Relaxed) {
            tracing::warn!(
                "{what}: size cap of {cap} reached; the entries seen the longest ago are dropped (logged once)"
            );
        }
    }
}

impl Default for WarnOnce {
    fn default() -> Self {
        Self::new()
    }
}

/// How many entries to drop when a cap is reached: a tenth of the cap, so the
/// cost of the scan is shared over many insertions.
pub fn batch_size(cap: usize) -> usize {
    (cap / 10).max(1)
}

/// The keys of the `n` smallest stamps (oldest first).
pub fn oldest_keys<K, T: Ord>(items: impl Iterator<Item = (K, T)>, n: usize) -> Vec<K> {
    let mut all: Vec<(T, K)> = items.map(|(k, t)| (t, k)).collect();
    all.sort_by(|a, b| a.0.cmp(&b.0));
    all.into_iter().take(n).map(|(_, k)| k).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oldest_keys_returns_the_smallest_stamps_in_order() {
        let items = vec![("c", 3), ("a", 1), ("d", 4), ("b", 2)];
        assert_eq!(oldest_keys(items.into_iter(), 2), vec!["a", "b"]);
    }

    #[test]
    fn oldest_keys_handles_n_larger_than_input() {
        let items = vec![("a", 1)];
        assert_eq!(oldest_keys(items.into_iter(), 5), vec!["a"]);
    }

    #[test]
    fn batch_size_is_a_tenth_with_a_floor_of_one() {
        assert_eq!(batch_size(10_000), 1_000);
        assert_eq!(batch_size(3), 1);
        assert_eq!(batch_size(0), 1);
    }
}
