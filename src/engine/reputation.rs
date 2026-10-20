//! Active Defense & Reputation Module
//!
//! Tracks agent behavior over time and enforces automated defense mechanisms (bans, throttling)
//! when threat thresholds are exceeded.
//!
//! "The Immune System of the Agent Mesh"

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};

const MAX_SCORE: i32 = 100;
const INITIAL_SCORE: i32 = 50;
const BAN_THRESHOLD: i32 = 0; // A score at or below 0 bans the agent
const BAN_DURATION_MINUTES: i64 = 10;
/// Default cap on distinct agent ids seen per namespace.
pub const DEFAULT_MAX_AGENT_IDS: usize = 256;
/// Default cap on per-connection score entries kept in memory.
pub const DEFAULT_MAX_ENTRIES: usize = 10_000;
/// Default idle time after which a score entry is dropped (three times the ban duration, so a
/// ban always outlives its own cleanup; an active ban is never dropped whatever this says).
pub const DEFAULT_IDLE_TTL_MINUTES: i64 = 3 * BAN_DURATION_MINUTES;
/// Separator between the namespace and the rest of a reputation key.
const KEY_SEP: char = '\u{1f}';

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
    /// Last time this entry was updated; used only for cleanup, not part of the API output.
    #[serde(skip)]
    last_active: Option<DateTime<Utc>>,
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
            last_active: None,
        }
    }
}

pub struct ReputationSystem {
    // Map of AgentID -> Score
    scores: Arc<RwLock<HashMap<String, ReputationScore>>>,
    // Namespace -> end of the ban that every key of that namespace inherits. A key is
    // `<namespace><US><connection>`; a ban earned on one connection holds for the namespace, so
    // reconnecting or changing the agent id does not start clean.
    ns_bans: Arc<RwLock<HashMap<String, DateTime<Utc>>>>,
    // Namespace -> distinct agent ids seen (bounded by `max_ids`).
    ids: Arc<RwLock<HashMap<String, HashSet<String>>>>,
    max_ids: usize,
    max_entries: usize,
    idle_ttl: Duration,
}

impl ReputationSystem {
    pub fn new() -> Self {
        Self::with_max_ids(DEFAULT_MAX_AGENT_IDS)
    }

    /// Reputation system that admits at most `max_ids` distinct agent ids per namespace.
    pub fn with_max_ids(max_ids: usize) -> Self {
        Self::with_limits(
            max_ids,
            DEFAULT_MAX_ENTRIES,
            Duration::minutes(DEFAULT_IDLE_TTL_MINUTES),
        )
    }

    /// Reputation system with explicit memory bounds: at most `max_entries` score entries, and
    /// entries idle longer than `idle_ttl` are dropped by `sweep_idle`.
    pub fn with_limits(max_ids: usize, max_entries: usize, idle_ttl: Duration) -> Self {
        Self {
            scores: Arc::new(RwLock::new(HashMap::new())),
            ns_bans: Arc::new(RwLock::new(HashMap::new())),
            ids: Arc::new(RwLock::new(HashMap::new())),
            max_ids,
            max_entries: max_entries.max(1),
            idle_ttl,
        }
    }

    fn ban_is_active(entry: &ReputationScore, now: DateTime<Utc>) -> bool {
        entry.status == AgentStatus::Banned && matches!(entry.banned_until, Some(end) if now < end)
    }

    /// Make room for one new key: when the map is full, evict the entry idle the longest.
    /// An actively banned entry is never evicted; if only those remain, the map is allowed to
    /// exceed the cap until their bans end (a ban lasts minutes).
    fn make_room(&self, scores: &mut HashMap<String, ReputationScore>, key: &str) {
        if scores.contains_key(key) || scores.len() < self.max_entries {
            return;
        }
        let now = Utc::now();
        let oldest = scores
            .iter()
            .filter(|(_, e)| !Self::ban_is_active(e, now))
            .min_by_key(|(_, e)| e.last_active)
            .map(|(k, _)| k.clone());
        if let Some(k) = oldest {
            scores.remove(&k);
        }
    }

    /// Forget a connection that closed. A standing ban on the entry is kept (and the namespace
    /// ban is untouched either way); it is dropped by `sweep_idle` once the ban has ended.
    pub fn remove_connection(&self, key: &str) {
        let mut scores = self.scores.write().unwrap();
        if let Some(entry) = scores.get(key) {
            if !Self::ban_is_active(entry, Utc::now()) {
                scores.remove(key);
            }
        }
    }

    /// Drop entries idle longer than the TTL (never an active ban) and namespace bans that
    /// have ended. Returns the number of score entries removed.
    pub fn sweep_idle(&self) -> usize {
        let now = Utc::now();
        let mut scores = self.scores.write().unwrap();
        let before = scores.len();
        let ttl = self.idle_ttl;
        scores.retain(|_, e| {
            Self::ban_is_active(e, now) || matches!(e.last_active, Some(t) if now - t <= ttl)
        });
        let removed = before - scores.len();
        drop(scores);
        self.ns_bans.write().unwrap().retain(|_, end| now < *end);
        removed
    }

    /// Number of score entries held (for tests and metrics).
    pub fn entry_count(&self) -> usize {
        self.scores.read().unwrap().len()
    }

    /// Namespace part of a key (`<namespace><US><connection>`), if the key has one.
    fn namespace_of(key: &str) -> Option<&str> {
        key.split_once(KEY_SEP).map(|(ns, _)| ns)
    }

    /// Admit an agent id for a namespace. Known ids always pass; a new id past the per-namespace
    /// cap is refused, so rotating ids cannot grow state without limit.
    pub fn admit_agent_id(&self, namespace: &str, agent_id: &str) -> Result<(), String> {
        let mut ids = self.ids.write().unwrap();
        let set = ids.entry(namespace.to_string()).or_default();
        if set.contains(agent_id) {
            return Ok(());
        }
        if set.len() >= self.max_ids {
            return Err(format!(
                "Too many distinct agent ids in this namespace (limit {})",
                self.max_ids
            ));
        }
        set.insert(agent_id.to_string());
        Ok(())
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
        if let Some(ns) = Self::namespace_of(agent_id) {
            if let Some(end) = self.ns_bans.read().unwrap().get(ns) {
                if Utc::now() < *end {
                    return Err(format!(
                        "Namespace BANNED active defense system until {}",
                        end
                    ));
                }
            }
        }
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
        self.make_room(&mut scores, agent_id);
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

        entry.last_active = Some(Utc::now());
        entry.total_calls += 1;
        entry.score = (entry.score + 1).min(MAX_SCORE);
        entry.update_status();
    }

    /// Record a security violation (Block)
    pub fn record_violation(&self, agent_id: &str, reason: &str, severity: i32) {
        let mut scores = self.scores.write().unwrap();
        self.make_room(&mut scores, agent_id);
        let entry = scores
            .entry(agent_id.to_string())
            .or_insert(ReputationScore {
                agent_id: agent_id.to_string(),
                ..Default::default()
            });

        entry.last_active = Some(Utc::now());
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

        // A fresh or standing ban also covers the namespace.
        let ban_end = match (&entry.status, entry.banned_until) {
            (AgentStatus::Banned, Some(end)) if Utc::now() < end => Some(end),
            _ => None,
        };
        drop(scores);
        if let (Some(end), Some(ns)) = (ban_end, Self::namespace_of(agent_id)) {
            let mut bans = self.ns_bans.write().unwrap();
            let slot = bans.entry(ns.to_string()).or_insert(end);
            if *slot < end {
                *slot = end;
            }
        }
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

    fn key(ns: &str, conn: &str) -> String {
        format!("{ns}{KEY_SEP}{conn}")
    }

    fn age(sys: &ReputationSystem, agent: &str, minutes: i64) {
        let mut scores = sys.scores.write().unwrap();
        scores
            .get_mut(agent)
            .expect("agent should exist")
            .last_active = Some(Utc::now() - Duration::minutes(minutes));
    }

    #[test]
    fn disconnect_removes_the_connections_entries_only() {
        let sys = ReputationSystem::default();
        let a = key("tenant-a", "ws-1");
        let b = key("tenant-a", "ws-2");
        sys.record_success(&a);
        sys.record_violation(&b, "x", 5);
        sys.remove_connection(&a);
        assert!(!sys.all_scores().contains_key(&a));
        assert!(sys.all_scores().contains_key(&b));
        assert_eq!(sys.entry_count(), 1);
    }

    #[test]
    fn disconnect_keeps_the_namespace_ban() {
        let sys = ReputationSystem::default();
        let a = key("tenant-a", "ws-1");
        sys.record_violation(&a, "x", 60);
        sys.remove_connection(&a);
        assert!(sys.check_agent_status(&key("tenant-a", "ws-2")).is_err());
        assert!(sys.check_agent_status(&a).is_err());
    }

    #[test]
    fn ttl_sweep_removes_idle_entries_but_keeps_active_bans() {
        let sys = ReputationSystem::default();
        let idle = key("t", "idle");
        let fresh = key("t", "fresh");
        let banned = key("u", "banned");
        sys.record_success(&idle);
        sys.record_success(&fresh);
        sys.record_violation(&banned, "x", 60);
        // Idle far past the TTL, the banned one too: its ban is still running.
        age(&sys, &idle, DEFAULT_IDLE_TTL_MINUTES + 5);
        age(&sys, &banned, DEFAULT_IDLE_TTL_MINUTES + 5);
        assert_eq!(sys.sweep_idle(), 1);
        let scores = sys.all_scores();
        assert!(!scores.contains_key(&idle));
        assert!(scores.contains_key(&fresh));
        assert!(scores.contains_key(&banned));
        assert!(sys.check_agent_status(&key("u", "other")).is_err());
        // Once the ban has ended, the entry and the namespace ban are swept too.
        set_ban_expiry(&sys, &banned, Utc::now() - Duration::minutes(1));
        sys.ns_bans
            .write()
            .unwrap()
            .insert("u".into(), Utc::now() - Duration::minutes(1));
        assert_eq!(sys.sweep_idle(), 1);
        assert!(sys.ns_bans.read().unwrap().is_empty());
        assert_eq!(sys.entry_count(), 1);
    }

    #[test]
    fn cap_evicts_the_oldest_idle_entry_and_never_a_banned_one() {
        let sys = ReputationSystem::with_limits(8, 3, Duration::minutes(30));
        let banned = key("t", "banned");
        let old = key("t", "old");
        let newer = key("t", "newer");
        sys.record_violation(&banned, "x", 60);
        sys.record_success(&old);
        sys.record_success(&newer);
        age(&sys, &banned, 100); // the oldest of all, but banned
        age(&sys, &old, 20);
        age(&sys, &newer, 10);
        sys.record_success(&key("t", "new"));
        let scores = sys.all_scores();
        assert_eq!(scores.len(), 3);
        assert!(scores.contains_key(&banned));
        assert!(!scores.contains_key(&old));
        assert!(scores.contains_key(&newer));
        // Existing keys are updated in place, without evicting anything.
        sys.record_success(&newer);
        assert_eq!(sys.entry_count(), 3);
    }

    #[test]
    fn cap_with_only_banned_entries_keeps_them_all() {
        let sys = ReputationSystem::with_limits(8, 1, Duration::minutes(30));
        let first = key("t", "1");
        sys.record_violation(&first, "x", 60);
        sys.record_violation(&key("t", "2"), "x", 60);
        assert_eq!(sys.entry_count(), 2);
        assert!(sys.check_agent_status(&first).is_err());
    }

    #[test]
    fn ban_on_one_connection_holds_for_the_whole_namespace() {
        let sys = ReputationSystem::default();
        let banned = key("tenant-a", "ws-1");
        sys.record_violation(&banned, "x", 60);
        assert!(sys.check_agent_status(&banned).is_err());
        // A new connection (rotated id, reconnect) in the same namespace inherits the ban.
        assert!(sys.check_agent_status(&key("tenant-a", "ws-2")).is_err());
        // Another namespace is untouched.
        assert!(sys.check_agent_status(&key("tenant-b", "ws-1")).is_ok());
    }

    #[test]
    fn namespace_ban_expires_with_the_ban() {
        let sys = ReputationSystem::default();
        let banned = key("tenant-a", "ws-1");
        sys.record_violation(&banned, "x", 60);
        sys.ns_bans
            .write()
            .unwrap()
            .insert("tenant-a".into(), Utc::now() - Duration::seconds(1));
        assert!(sys.check_agent_status(&key("tenant-a", "ws-2")).is_ok());
    }

    #[test]
    fn agent_id_cap_is_enforced_per_namespace() {
        let sys = ReputationSystem::with_max_ids(2);
        assert!(sys.admit_agent_id("a", "x").is_ok());
        assert!(sys.admit_agent_id("a", "y").is_ok());
        assert!(
            sys.admit_agent_id("a", "x").is_ok(),
            "known id still passes"
        );
        assert!(sys.admit_agent_id("a", "z").is_err());
        assert!(
            sys.admit_agent_id("b", "z").is_ok(),
            "other namespace has its own budget"
        );
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
