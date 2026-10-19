//! Active Defense & Reputation Module
//!
//! Tracks agent behavior over time and enforces automated defense mechanisms (bans, throttling)
//! when threat thresholds are exceeded.
//!
//! "The Immune System of the Agent Mesh"

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

const MAX_SCORE: i32 = 100;
const INITIAL_SCORE: i32 = 50;
const BAN_THRESHOLD: i32 = 0; // A score at or below 0 bans the agent
const BAN_DURATION_MINUTES: i64 = 10;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AgentStatus {
    Trusted,    // Score > 80
    Neutral,    // Score 20-80
    Suspicious, // Score 1-19
    Banned,     // Score <= BAN_THRESHOLD, until banned_until
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReputationScore {
    pub agent_id: String,
    pub score: i32,
    pub status: AgentStatus,
    pub total_calls: u64,
    pub blocked_calls: u64,
    pub last_violation: Option<DateTime<Utc>>,
    pub banned_until: Option<DateTime<Utc>>,
    pub violations: Vec<String>, // Log of last 5 violations
}

impl Default for ReputationScore {
    fn default() -> Self {
        Self {
            agent_id: "unknown".to_string(),
            score: INITIAL_SCORE,
            status: AgentStatus::Neutral,
            total_calls: 0,
            blocked_calls: 0,
            last_violation: None,
            banned_until: None,
            violations: Vec::new(),
        }
    }
}

pub struct ReputationSystem {
    // Map of AgentID -> Score
    scores: Arc<RwLock<HashMap<String, ReputationScore>>>,
}

impl ReputationSystem {
    pub fn new() -> Self {
        Self {
            scores: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

impl Default for ReputationSystem {
    fn default() -> Self {
        Self::new()
    }
}

impl ReputationSystem {
    /// Get current status of an agent (Auth Check)
    pub fn check_agent_status(&self, agent_id: &str) -> Result<(), String> {
        let scores = self.scores.read().unwrap();
        if let Some(entry) = scores.get(agent_id) {
            if entry.status == AgentStatus::Banned {
                if let Some(ban_end) = entry.banned_until {
                    if Utc::now() < ban_end {
                        return Err(format!(
                            "Agent BANNED active defense system until {}",
                            ban_end
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    /// Record a clean, allowed call
    pub fn record_success(&self, agent_id: &str) {
        let mut scores = self.scores.write().unwrap();
        let entry = scores
            .entry(agent_id.to_string())
            .or_insert(ReputationScore {
                agent_id: agent_id.to_string(),
                ..Default::default()
            });

        // Auto-unban check
        if entry.status == AgentStatus::Banned {
            if let Some(ban_end) = entry.banned_until {
                if Utc::now() > ban_end {
                    entry.status = AgentStatus::Suspicious; // Unban to suspicious
                    entry.score = 10; // Reset to low score
                    entry.banned_until = None;
                }
            }
        }

        entry.total_calls += 1;
        entry.score = (entry.score + 1).min(MAX_SCORE);
        entry.update_status();
    }

    /// Record a security violation (Block)
    pub fn record_violation(&self, agent_id: &str, reason: &str, severity: i32) {
        let mut scores = self.scores.write().unwrap();
        let entry = scores
            .entry(agent_id.to_string())
            .or_insert(ReputationScore {
                agent_id: agent_id.to_string(),
                ..Default::default()
            });

        entry.total_calls += 1;
        entry.blocked_calls += 1;
        entry.score -= severity;
        entry.last_violation = Some(Utc::now());

        // Keep last 5 violations
        entry.violations.push(reason.to_string());
        if entry.violations.len() > 5 {
            entry.violations.remove(0);
        }

        entry.update_status();
    }

    /// Get all scores for dashboard
    pub fn all_scores(&self) -> HashMap<String, ReputationScore> {
        self.scores.read().unwrap().clone()
    }
}

impl ReputationScore {
    fn update_status(&mut self) {
        // An active ban holds until `banned_until`, whatever the score does.
        let ban_active = self.status == AgentStatus::Banned
            && matches!(self.banned_until, Some(end) if Utc::now() < end);
        if ban_active {
            return;
        }

        if self.score <= BAN_THRESHOLD {
            // Reaching here means no ban is active: either the agent was never
            // banned or its previous ban has expired. Ban (again) with a fresh timer.
            self.status = AgentStatus::Banned;
            self.banned_until = Some(Utc::now() + Duration::minutes(BAN_DURATION_MINUTES));
        } else if self.score < 20 {
            self.status = AgentStatus::Suspicious;
        } else if self.score > 80 {
            self.status = AgentStatus::Trusted;
        } else {
            self.status = AgentStatus::Neutral;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn score_of(sys: &ReputationSystem, agent: &str) -> ReputationScore {
        sys.all_scores()
            .remove(agent)
            .expect("agent should have a score")
    }

    fn set_ban_expiry(sys: &ReputationSystem, agent: &str, when: DateTime<Utc>) {
        let mut scores = sys.scores.write().unwrap();
        scores
            .get_mut(agent)
            .expect("agent should exist")
            .banned_until = Some(when);
    }

    fn succeed_times(sys: &ReputationSystem, agent: &str, n: usize) {
        for _ in 0..n {
            sys.record_success(agent);
        }
    }

    #[test]
    fn unknown_agent_is_allowed_and_registry_starts_empty() {
        let sys = ReputationSystem::default();
        assert!(sys.check_agent_status("nobody").is_ok());
        assert!(sys.all_scores().is_empty());
    }

    #[test]
    fn first_success_creates_neutral_entry_at_initial_score() {
        let sys = ReputationSystem::new();
        sys.record_success("agent-1");
        let s = score_of(&sys, "agent-1");
        assert_eq!(s.score, 51);
        assert_eq!(s.status, AgentStatus::Neutral);
        assert_eq!(s.total_calls, 1);
        assert_eq!(s.blocked_calls, 0);
        assert!(s.banned_until.is_none());
    }

    #[test]
    fn score_is_capped_at_max() {
        let sys = ReputationSystem::new();
        succeed_times(&sys, "agent-1", 80);
        let s = score_of(&sys, "agent-1");
        assert_eq!(s.score, MAX_SCORE);
        assert_eq!(s.status, AgentStatus::Trusted);
        assert_eq!(s.total_calls, 80);
    }

    #[test]
    fn trusted_starts_strictly_above_80() {
        let sys = ReputationSystem::new();
        succeed_times(&sys, "agent-1", 30);
        assert_eq!(score_of(&sys, "agent-1").score, 80);
        assert_eq!(score_of(&sys, "agent-1").status, AgentStatus::Neutral);
        sys.record_success("agent-1");
        assert_eq!(score_of(&sys, "agent-1").score, 81);
        assert_eq!(score_of(&sys, "agent-1").status, AgentStatus::Trusted);
    }

    #[test]
    fn suspicious_boundary_is_below_20() {
        let sys = ReputationSystem::new();
        sys.record_violation("agent-1", "probe", 30);
        assert_eq!(score_of(&sys, "agent-1").score, 20);
        assert_eq!(score_of(&sys, "agent-1").status, AgentStatus::Neutral);
        sys.record_violation("agent-1", "probe", 1);
        assert_eq!(score_of(&sys, "agent-1").score, 19);
        assert_eq!(score_of(&sys, "agent-1").status, AgentStatus::Suspicious);
    }

    #[test]
    fn reaching_zero_bans_the_agent() {
        let sys = ReputationSystem::new();
        sys.record_violation("agent-1", "x", 49);
        let s = score_of(&sys, "agent-1");
        assert_eq!(s.score, 1);
        assert_eq!(s.status, AgentStatus::Suspicious);
        assert!(s.banned_until.is_none());

        sys.record_violation("agent-1", "x", 1);
        let s = score_of(&sys, "agent-1");
        assert_eq!(s.score, 0);
        assert_eq!(s.status, AgentStatus::Banned);
        assert!(s.banned_until.is_some());
        let err = sys.check_agent_status("agent-1").unwrap_err();
        assert!(err.contains("BANNED"), "unexpected message: {err}");
    }

    #[test]
    fn expired_ban_is_not_enforced_by_the_auth_check() {
        let sys = ReputationSystem::new();
        sys.record_violation("agent-1", "x", 60);
        assert!(sys.check_agent_status("agent-1").is_err());
        set_ban_expiry(&sys, "agent-1", Utc::now() - Duration::minutes(1));
        assert!(sys.check_agent_status("agent-1").is_ok());
    }

    #[test]
    fn success_after_expired_ban_resets_to_suspicious_at_ten() {
        let sys = ReputationSystem::new();
        sys.record_violation("agent-1", "x", 60);
        set_ban_expiry(&sys, "agent-1", Utc::now() - Duration::minutes(1));
        sys.record_success("agent-1");
        let s = score_of(&sys, "agent-1");
        assert_eq!(s.score, 11);
        assert_eq!(s.status, AgentStatus::Suspicious);
        assert!(s.banned_until.is_none());
    }

    #[test]
    fn active_ban_survives_a_success_that_raises_the_score() {
        let sys = ReputationSystem::new();
        sys.record_violation("agent-1", "x", 50);
        assert!(sys.check_agent_status("agent-1").is_err());
        sys.record_success("agent-1");
        let s = score_of(&sys, "agent-1");
        assert_eq!(s.score, 1);
        assert_eq!(s.status, AgentStatus::Banned);
        assert!(sys.check_agent_status("agent-1").is_err());
    }

    #[test]
    fn violation_after_expired_ban_bans_again() {
        let sys = ReputationSystem::new();
        sys.record_violation("agent-1", "x", 60);
        set_ban_expiry(&sys, "agent-1", Utc::now() - Duration::minutes(1));
        assert!(sys.check_agent_status("agent-1").is_ok());
        // The score is still at or below the threshold; a new violation must ban again.
        sys.record_violation("agent-1", "again", 1);
        let s = score_of(&sys, "agent-1");
        assert_eq!(s.status, AgentStatus::Banned);
        assert!(matches!(s.banned_until, Some(end) if end > Utc::now()));
        assert!(sys.check_agent_status("agent-1").is_err());
    }

    #[test]
    fn violation_during_active_ban_does_not_extend_it() {
        let sys = ReputationSystem::new();
        sys.record_violation("agent-1", "x", 60);
        let first = score_of(&sys, "agent-1").banned_until;
        sys.record_violation("agent-1", "y", 5);
        let s = score_of(&sys, "agent-1");
        assert_eq!(s.status, AgentStatus::Banned);
        assert_eq!(s.banned_until, first);
    }

    #[test]
    fn violation_log_keeps_only_the_last_five_reasons() {
        let sys = ReputationSystem::new();
        for i in 0..7 {
            sys.record_violation("agent-1", &format!("v{i}"), 1);
        }
        let s = score_of(&sys, "agent-1");
        assert_eq!(s.violations, vec!["v2", "v3", "v4", "v5", "v6"]);
        assert_eq!(s.blocked_calls, 7);
        assert_eq!(s.total_calls, 7);
        assert!(s.last_violation.is_some());
    }

    #[test]
    fn success_and_violation_counters_are_tracked_separately() {
        let sys = ReputationSystem::new();
        succeed_times(&sys, "agent-1", 2);
        sys.record_violation("agent-1", "x", 1);
        let s = score_of(&sys, "agent-1");
        assert_eq!(s.total_calls, 3);
        assert_eq!(s.blocked_calls, 1);
        assert_eq!(s.violations.len(), 1);
    }

    #[test]
    fn agents_are_scored_independently() {
        let sys = ReputationSystem::new();
        sys.record_violation("bad", "x", 60);
        sys.record_success("good");
        assert!(sys.check_agent_status("bad").is_err());
        assert!(sys.check_agent_status("good").is_ok());
        assert_eq!(score_of(&sys, "good").score, 51);
    }

    #[test]
    fn all_scores_returns_a_snapshot() {
        let sys = ReputationSystem::new();
        sys.record_success("agent-1");
        let mut snapshot = sys.all_scores();
        snapshot.get_mut("agent-1").unwrap().score = 999;
        assert_eq!(score_of(&sys, "agent-1").score, 51);
        assert!(sys.all_scores().contains_key("agent-1"));
    }
}
