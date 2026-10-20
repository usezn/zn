use crate::config::LoopBreakerConfig;
use dashmap::DashMap;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Entry in the action history
struct ActionEntry {
    tool_name: String,
    arguments_hash: u64,
    timestamp: Instant,
}

/// Recursive Loop Breaker Engine
pub struct LoopBreaker {
    /// History per agent: agent_id -> VecDeque of recent actions
    history: DashMap<String, VecDeque<ActionEntry>>,
    config: LoopBreakerConfig,
}

impl LoopBreaker {
    pub fn new(config: LoopBreakerConfig) -> Self {
        Self {
            history: DashMap::new(),
            config,
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

        let mut agent_history = self.history.entry(agent_id.to_string()).or_default();

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
    fn loop_state_is_per_namespace_and_connection_key() {
        // The gateway keys the breaker by `<namespace><US><connection>`, not by the agent id.
        let lb = breaker(true, 1);
        let a = "tenant-a\u{1f}ws-1";
        let b = "tenant-b\u{1f}ws-1";
        assert!(lb.check_and_record(a, "shell", "{}").is_ok());
        assert!(lb.check_and_record(a, "shell", "{}").is_err());
        assert!(lb.check_and_record(b, "shell", "{}").is_ok());
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
        assert_eq!(lb.history.get("agent-1").map(|h| h.len()), Some(2));
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
            for entry in history.iter_mut() {
                entry.timestamp = old;
            }
        }
        assert!(lb.check_and_record("agent-1", "shell", "{}").is_ok());
    }
}
