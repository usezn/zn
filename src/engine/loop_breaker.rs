use super::bounded::{
    batch_size, oldest_keys, WarnOnce, MAX_LOOP_BREAKER_AGENTS, MIN_LOOP_BREAKER_ACTIONS_PER_AGENT,
    SWEEP_EVERY,
};
use crate::config::LoopBreakerConfig;
use dashmap::DashMap;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

/// Entry in the action history
struct ActionEntry {
    tool_name: String,
    arguments_hash: u64,
    timestamp: Instant,
}

/// Recent actions of one agent and when the agent last called.
struct AgentHistory {
    queue: VecDeque<ActionEntry>,
    last_seen: Instant,
}

/// Recursive Loop Breaker Engine
///
/// Memory is bounded: at most `max_agents` agents are tracked (10,000 by
/// default; the ones seen the longest ago are dropped first, never the caller),
/// each agent keeps at most `max_actions_per_agent` actions (1,000, or
/// `max_repeats + 1` if that is larger), and agents idle for longer than the
/// window are removed.
pub struct LoopBreaker {
    /// History per agent: agent_id -> recent actions
    history: DashMap<String, AgentHistory>,
    config: LoopBreakerConfig,
    max_agents: usize,
    max_actions_per_agent: usize,
    new_agents: AtomicUsize,
    warned: WarnOnce,
}

impl LoopBreaker {
    pub fn new(config: LoopBreakerConfig) -> Self {
        Self::with_limits(
            config,
            MAX_LOOP_BREAKER_AGENTS,
            MIN_LOOP_BREAKER_ACTIONS_PER_AGENT,
        )
    }

    pub fn with_limits(
        config: LoopBreakerConfig,
        max_agents: usize,
        max_actions_per_agent: usize,
    ) -> Self {
        // The queue must be able to hold one more action than the repeat limit,
        // or a loop could never be seen.
        let max_actions_per_agent = max_actions_per_agent
            .max(config.max_repeats.saturating_add(1))
            .max(1);
        Self {
            history: DashMap::new(),
            config,
            max_agents: max_agents.max(1),
            max_actions_per_agent,
            new_agents: AtomicUsize::new(0),
            warned: WarnOnce::new(),
        }
    }

    /// Called before a new agent is added: drops agents idle for longer than
    /// the window (every `SWEEP_EVERY` new agents, and whenever the cap is
    /// reached) and, if still full, the agents seen the longest ago.
    fn make_room(&self, now: Instant, window: Duration) {
        let n = self.new_agents.fetch_add(1, Ordering::Relaxed) + 1;
        let full = self.history.len() >= self.max_agents;
        if !full && !n.is_multiple_of(SWEEP_EVERY) {
            return;
        }
        self.history
            .retain(|_, h| now.duration_since(h.last_seen) <= window);
        if self.history.len() >= self.max_agents {
            self.warned.warn("loop breaker agents", self.max_agents);
            let drop = batch_size(self.max_agents);
            let keys = oldest_keys(
                self.history.iter().map(|e| (e.key().clone(), e.last_seen)),
                drop,
            );
            for k in keys {
                self.history.remove(&k);
            }
        }
    }

    /// Check if a tool call is part of an infinite loop
    pub fn check_and_record(
        &self,
        agent_id: &str,
        tool_name: &str,
        arguments: &str,
    ) -> std::result::Result<(), String> {
        if !self.config.enabled {
            return Ok(());
        }

        let normalized_args = self.normalize_arguments(arguments);
        let hash = self.compute_hash(&normalized_args);
        let now = Instant::now();
        let window = Duration::from_secs(self.config.window_seconds);

        // Make room before taking the entry lock; the caller is not in the map yet,
        // so it can never be the one that is dropped.
        if !self.history.contains_key(agent_id) {
            self.make_room(now, window);
        }
        let mut entry = self
            .history
            .entry(agent_id.to_string())
            .or_insert_with(|| AgentHistory {
                queue: VecDeque::new(),
                last_seen: now,
            });
        entry.last_seen = now;
        let agent_history = &mut entry.queue;

        // Cleanup old entries
        while agent_history
            .front()
            .is_some_and(|e| now.duration_since(e.timestamp) > window)
        {
            agent_history.pop_front();
        }

        // Count repeats
        let repeats = agent_history
            .iter()
            .filter(|e| e.tool_name == tool_name && e.arguments_hash == hash)
            .count();

        if repeats >= self.config.max_repeats {
            return Err(format!(
                "Recursive loop detected: Tool '{}' called {} times with identical arguments in {}s",
                tool_name, repeats + 1, self.config.window_seconds
            ));
        }

        // Record current action
        agent_history.push_back(ActionEntry {
            tool_name: tool_name.to_string(),
            arguments_hash: hash,
            timestamp: now,
        });
        while agent_history.len() > self.max_actions_per_agent {
            agent_history.pop_front();
        }

        Ok(())
    }

    fn compute_hash(&self, arguments: &str) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        arguments.hash(&mut hasher);
        hasher.finish()
    }

    /// Normalize JSON strings to a canonical representation to prevent bypasses
    fn normalize_arguments(&self, arguments: &str) -> String {
        match serde_json::from_str::<serde_json::Value>(arguments) {
            Ok(v) => v.to_string(), // serde_json::to_string() produces a compact, sorted key-order JSON
            Err(_) => arguments.to_string(), // Fallback for non-JSON content
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn breaker(enabled: bool, max_repeats: usize) -> LoopBreaker {
        LoopBreaker::new(LoopBreakerConfig {
            enabled,
            max_repeats,
            window_seconds: 60,
        })
    }

    #[test]
    fn disabled_breaker_allows_everything_and_records_nothing() {
        let lb = breaker(false, 1);
        for _ in 0..10 {
            assert!(lb.check_and_record("agent-1", "shell", "{}").is_ok());
        }
        assert!(lb.history.is_empty());
    }

    #[test]
    fn default_limit_allows_three_calls_and_blocks_the_fourth() {
        let lb = LoopBreaker::new(LoopBreakerConfig::default());
        for call in 1..=3 {
            assert!(
                lb.check_and_record("agent-1", "shell", "{}").is_ok(),
                "call {call} should pass"
            );
        }
        let err = lb.check_and_record("agent-1", "shell", "{}").unwrap_err();
        assert_eq!(
            err,
            "Recursive loop detected: Tool 'shell' called 4 times with identical arguments in 60s"
        );
    }

    #[test]
    fn blocked_calls_are_not_recorded_so_the_loop_stays_blocked() {
        let lb = breaker(true, 2);
        assert!(lb.check_and_record("agent-1", "shell", "{}").is_ok());
        assert!(lb.check_and_record("agent-1", "shell", "{}").is_ok());
        assert!(lb.check_and_record("agent-1", "shell", "{}").is_err());
        assert!(lb.check_and_record("agent-1", "shell", "{}").is_err());
        assert_eq!(lb.history.get("agent-1").map(|h| h.queue.len()), Some(2));
    }

    #[test]
    fn limit_of_one_blocks_the_second_identical_call() {
        let lb = breaker(true, 1);
        assert!(lb.check_and_record("agent-1", "shell", "{}").is_ok());
        assert!(lb.check_and_record("agent-1", "shell", "{}").is_err());
    }

    #[test]
    fn distinct_arguments_do_not_count_as_repeats() {
        let lb = breaker(true, 2);
        for i in 0..20 {
            let args = format!("{{\"n\":{i}}}");
            assert!(lb.check_and_record("agent-1", "shell", &args).is_ok());
        }
    }

    #[test]
    fn same_arguments_on_different_tools_do_not_count_as_repeats() {
        let lb = breaker(true, 1);
        for tool in ["read", "write", "delete"] {
            assert!(lb.check_and_record("agent-1", tool, "{}").is_ok());
        }
    }

    #[test]
    fn agents_have_independent_histories() {
        let lb = breaker(true, 1);
        assert!(lb.check_and_record("agent-1", "shell", "{}").is_ok());
        assert!(lb.check_and_record("agent-2", "shell", "{}").is_ok());
        assert!(lb.check_and_record("agent-1", "shell", "{}").is_err());
        assert!(lb.check_and_record("agent-2", "shell", "{}").is_err());
    }

    #[test]
    fn json_key_order_and_whitespace_are_normalized() {
        let lb = breaker(true, 2);
        assert!(lb
            .check_and_record("agent-1", "shell", r#"{"a":1,"b":2}"#)
            .is_ok());
        assert!(lb
            .check_and_record("agent-1", "shell", r#"{"b": 2, "a": 1}"#)
            .is_ok());
        assert!(lb
            .check_and_record("agent-1", "shell", "{ \"a\" : 1 ,\n \"b\" : 2 }")
            .is_err());
    }

    #[test]
    fn non_json_arguments_are_compared_byte_for_byte() {
        let lb = breaker(true, 1);
        assert!(lb.check_and_record("agent-1", "shell", "run  now").is_ok());
        assert!(lb.check_and_record("agent-1", "shell", "run now").is_ok());
        assert!(lb.check_and_record("agent-1", "shell", "run now").is_err());
    }

    #[test]
    fn entries_older_than_the_window_are_dropped() {
        let lb = breaker(true, 1);
        assert!(lb.check_and_record("agent-1", "shell", "{}").is_ok());
        assert!(lb.check_and_record("agent-1", "shell", "{}").is_err());

        // Age the recorded entry well past the 60 s window.
        let old = Instant::now()
            .checked_sub(Duration::from_secs(120))
            .expect("instant should support a 120 s offset");
        if let Some(mut history) = lb.history.get_mut("agent-1") {
            for entry in history.queue.iter_mut() {
                entry.timestamp = old;
            }
        }
        assert!(lb.check_and_record("agent-1", "shell", "{}").is_ok());
    }

    fn small(max_agents: usize, max_repeats: usize) -> LoopBreaker {
        LoopBreaker::with_limits(
            LoopBreakerConfig {
                enabled: true,
                max_repeats,
                window_seconds: 60,
            },
            max_agents,
            1_000,
        )
    }

    #[test]
    fn default_caps_are_documented_values() {
        let lb = LoopBreaker::new(LoopBreakerConfig::default());
        assert_eq!(lb.max_agents, 10_000);
        assert_eq!(lb.max_actions_per_agent, 1_000);
    }

    #[test]
    fn agent_cap_is_respected_with_new_ids_on_every_call() {
        let lb = small(100, 3);
        for i in 0..5_000 {
            assert!(lb.check_and_record(&format!("a-{i}"), "t", "{}").is_ok());
            assert!(lb.history.len() <= 100);
        }
        assert!(lb.history.len() <= 100);
    }

    #[test]
    fn least_recently_seen_agents_are_dropped_first() {
        let lb = small(10, 3);
        for i in 0..10 {
            lb.check_and_record(&format!("a-{i}"), "t", "{}").unwrap();
        }
        // a-0 calls again: it is now the most recent.
        lb.check_and_record("a-0", "t", "{}").unwrap();
        lb.check_and_record("new", "t", "{}").unwrap();
        assert!(lb.history.contains_key("a-0"));
        assert!(lb.history.contains_key("new"));
        assert!(!lb.history.contains_key("a-1"), "oldest is dropped");
    }

    #[test]
    fn flooding_new_ids_does_not_reset_an_active_looping_agent() {
        let lb = small(50, 2);
        assert!(lb.check_and_record("looper", "shell", "{}").is_ok());
        assert!(lb.check_and_record("looper", "shell", "{}").is_ok());
        for i in 0..2_000 {
            let _ = lb.check_and_record(&format!("flood-{i}"), "t", "{}");
            // The looper keeps calling, so it stays the most recently seen
            // and the loop stays blocked.
            if i % 5 == 0 {
                assert!(lb.check_and_record("looper", "shell", "{}").is_err());
            }
        }
        assert!(lb.check_and_record("looper", "shell", "{}").is_err());
    }

    #[test]
    fn the_calling_agent_is_never_dropped_by_its_own_insert() {
        let lb = small(1, 3);
        lb.check_and_record("a", "t", "{}").unwrap();
        lb.check_and_record("b", "t", "{}").unwrap();
        assert!(lb.history.contains_key("b"));
        assert_eq!(lb.history.len(), 1);
    }

    #[test]
    fn per_agent_queue_is_bounded_by_count() {
        let lb = LoopBreaker::with_limits(
            LoopBreakerConfig {
                enabled: true,
                max_repeats: 3,
                window_seconds: 60,
            },
            100,
            20,
        );
        for i in 0..500 {
            let args = format!("{{\"n\":{i}}}");
            assert!(lb.check_and_record("a", "t", &args).is_ok());
        }
        assert_eq!(lb.history.get("a").map(|h| h.queue.len()), Some(20));
    }

    #[test]
    fn queue_cap_never_hides_the_repeat_limit() {
        // A tiny requested cap is raised so max_repeats still works.
        let lb = LoopBreaker::with_limits(
            LoopBreakerConfig {
                enabled: true,
                max_repeats: 5,
                window_seconds: 60,
            },
            100,
            1,
        );
        for _ in 0..5 {
            assert!(lb.check_and_record("a", "t", "{}").is_ok());
        }
        assert!(lb.check_and_record("a", "t", "{}").is_err());
    }

    #[test]
    fn idle_agents_are_expired_when_the_cap_is_reached() {
        let lb = small(10, 3);
        for i in 0..10 {
            lb.check_and_record(&format!("old-{i}"), "t", "{}").unwrap();
        }
        let old = Instant::now()
            .checked_sub(Duration::from_secs(300))
            .expect("instant should support a 300 s offset");
        for mut h in lb.history.iter_mut() {
            h.last_seen = old;
        }
        lb.check_and_record("fresh", "t", "{}").unwrap();
        assert_eq!(
            lb.history.len(),
            1,
            "expired agents are removed, not just the oldest tenth"
        );
        assert!(lb.history.contains_key("fresh"));
    }

    #[test]
    fn idle_agents_are_expired_periodically_before_the_cap() {
        let lb = small(100_000, 3);
        for i in 0..10 {
            lb.check_and_record(&format!("old-{i}"), "t", "{}").unwrap();
        }
        let old = Instant::now()
            .checked_sub(Duration::from_secs(300))
            .expect("instant should support a 300 s offset");
        for mut h in lb.history.iter_mut() {
            h.last_seen = old;
        }
        for i in 0..SWEEP_EVERY {
            lb.check_and_record(&format!("new-{i}"), "t", "{}").unwrap();
        }
        assert!(!lb.history.contains_key("old-0"));
    }
}
