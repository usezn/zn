use super::bounded::{oldest_keys, WarnOnce, MAX_PENDING_ACTIONS};
use crate::config::ConsensusConfig;
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

type Clock = Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WitnessType {
    DeterministicPolicy(String), // WASM policy name
    NeuralJudge,
    HumanAdmin(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Signature {
    pub witness: WitnessType,
    pub timestamp: DateTime<Utc>,
    pub metadata: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorizableAction {
    pub id: String,
    /// Namespace of the connection that proposed the action: only a call from the same namespace can use
    /// its approval.
    #[serde(default)]
    pub namespace: String,
    pub agent_id: String,
    pub tool_name: String,
    pub arguments_hash: String, // Ensure request hasn't changed
    pub timestamp: DateTime<Utc>,
    pub signatures: Vec<Signature>,
    pub required_m: u32,
    pub status: ActionStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ActionStatus {
    Pending,
    Approved,
    Denied,
    Expired,
}

/// M-of-N Consensus Manager
///
/// Actions older than the TTL are removed on every access. At most 1,000
/// actions wait at once; when a new proposal would pass that, the oldest one
/// is dropped (the new one is always kept).
pub struct ConsensusManager {
    /// Pending actions: action_id -> Action
    pending: DashMap<String, AuthorizableAction>,
    config: ConsensusConfig,
    clock: Clock,
    max_pending: usize,
    warned: WarnOnce,
}

impl ConsensusManager {
    pub fn new(config: ConsensusConfig) -> Self {
        Self::with_clock(config, Arc::new(Utc::now))
    }

    /// Build a manager with its own clock (used by tests).
    pub fn with_clock(config: ConsensusConfig, clock: Clock) -> Self {
        Self {
            pending: DashMap::new(),
            config,
            clock,
            max_pending: MAX_PENDING_ACTIONS,
            warned: WarnOnce::new(),
        }
    }

    /// Change the cap on waiting actions (used by tests).
    pub fn with_max_pending(mut self, max_pending: usize) -> Self {
        self.max_pending = max_pending.max(1);
        self
    }

    fn now(&self) -> DateTime<Utc> {
        (self.clock)()
    }

    /// Lifetime of a proposed action. A zero setting falls back to the default.
    fn ttl(&self) -> chrono::Duration {
        let secs = if self.config.pending_ttl_secs == 0 {
            900
        } else {
            self.config.pending_ttl_secs
        };
        // Cap at ten years so the conversion cannot overflow.
        chrono::Duration::seconds(i64::try_from(secs).unwrap_or(i64::MAX).min(315_360_000))
    }

    fn is_expired(&self, action: &AuthorizableAction, now: DateTime<Utc>) -> bool {
        now.signed_duration_since(action.timestamp) >= self.ttl()
    }

    /// Remove every action older than the TTL, whatever its status. Runs on
    /// every access, so unresolved actions cannot pile up.
    fn purge_expired(&self) {
        let now = self.now();
        self.pending.retain(|_, a| !self.is_expired(a, now));
    }

    /// Check if a tool needs consensus and register it if so
    pub fn propose_action(
        &self,
        namespace: &str,
        agent_id: &str,
        tool_name: &str,
        arguments: &str,
    ) -> Option<String> {
        if !self.config.enabled {
            return None;
        }
        self.purge_expired();

        // Check if tool is critical (supports wildcards)
        let is_critical = self.config.critical_tools.iter().any(|pattern| {
            if pattern.ends_with('*') {
                tool_name.starts_with(&pattern[..pattern.len() - 1])
            } else {
                tool_name == pattern
            }
        });

        if !is_critical {
            return None;
        }

        let args_hash = self.compute_hash(arguments);

        let action_id = Uuid::new_v4().to_string();
        let action = AuthorizableAction {
            id: action_id.clone(),
            namespace: namespace.to_string(),
            agent_id: agent_id.to_string(),
            tool_name: tool_name.to_string(),
            arguments_hash: args_hash,
            timestamp: self.now(),
            signatures: Vec::new(),
            required_m: self.config.required_signatures,
            status: ActionStatus::Pending,
        };

        // Expired actions were purged above; if the queue is still full, drop the oldest.
        while self.pending.len() >= self.max_pending {
            self.warned
                .warn("consensus pending actions", self.max_pending);
            let oldest = oldest_keys(
                self.pending.iter().map(|e| (e.key().clone(), e.timestamp)),
                1,
            );
            match oldest.first() {
                Some(id) => {
                    self.pending.remove(id);
                }
                None => break,
            }
        }
        self.pending.insert(action_id.clone(), action);
        Some(action_id)
    }

    /// Add a signature to a pending action
    pub fn sign_action(
        &self,
        action_id: &str,
        witness: WitnessType,
    ) -> std::result::Result<ActionStatus, String> {
        self.purge_expired();
        let mut action = self
            .pending
            .get_mut(action_id)
            .ok_or_else(|| "Action not found or already processed".to_string())?;

        // Only a pending action can collect signatures or change status.
        if action.status != ActionStatus::Pending {
            return Err("Action not found or already processed".to_string());
        }

        // Prevent duplicate signatures from same witness type
        if action
            .signatures
            .iter()
            .any(|s| match (&s.witness, &witness) {
                (WitnessType::DeterministicPolicy(n1), WitnessType::DeterministicPolicy(n2)) => {
                    n1 == n2
                }
                (WitnessType::NeuralJudge, WitnessType::NeuralJudge) => true,
                (WitnessType::HumanAdmin(u1), WitnessType::HumanAdmin(u2)) => u1 == u2,
                _ => false,
            })
        {
            return Ok(action.status.clone());
        }

        action.signatures.push(Signature {
            witness,
            timestamp: Utc::now(),
            metadata: None,
        });

        if action.signatures.len() >= action.required_m as usize {
            action.status = ActionStatus::Approved;
        }

        Ok(action.status.clone())
    }

    /// Deny an action. A denied action is final and is removed from the queue
    /// at once, so it can neither collect signatures later nor pile up.
    pub fn deny_action(&self, action_id: &str, _reason: &str) -> std::result::Result<(), String> {
        // Atomic: only a still-pending entry is removed.
        if self
            .pending
            .remove_if(action_id, |_, a| a.status == ActionStatus::Pending)
            .is_some()
        {
            return Ok(());
        }
        if self.pending.contains_key(action_id) {
            Err("Action not found or already processed".to_string())
        } else {
            Err("Action not found".to_string())
        }
    }

    /// Check if a specific action has been approved and matches the current request. The namespace is the
    /// one of the connection (never taken from the message), so an approval cannot be used from another one.
    pub fn check_approval(
        &self,
        namespace: &str,
        agent_id: &str,
        tool_name: &str,
        arguments: &str,
    ) -> bool {
        self.purge_expired();
        let hash = self.compute_hash(arguments);

        // Find matching approved action
        // Linear scan for simplicity; swap in a proper index if this path gets hot.
        let mut approved_id = None;
        for entry in self.pending.iter() {
            let action = entry.value();
            if action.status == ActionStatus::Approved
                && action.namespace == namespace
                && action.agent_id == agent_id
                && action.tool_name == tool_name
                && action.arguments_hash == hash
            {
                approved_id = Some(action.id.clone());
                break;
            }
        }

        if let Some(id) = approved_id {
            // "Consume" the approval so it can't be reused (TOCTOU fix).
            // Only the caller that removes the entry gets the approval, so two
            // concurrent checks can't both use the same one.
            return self.pending.remove(&id).is_some();
        }

        false
    }

    /// Get current status of an action
    pub fn get_status(&self, action_id: &str) -> Option<ActionStatus> {
        let now = self.now();
        self.pending.get(action_id).map(|a| {
            if self.is_expired(&a, now) {
                ActionStatus::Expired
            } else {
                a.status.clone()
            }
        })
    }

    /// List all pending actions
    pub fn list_pending(&self) -> Vec<AuthorizableAction> {
        self.purge_expired();
        self.pending
            .iter()
            .filter(|e| e.status == ActionStatus::Pending)
            .map(|e| e.value().clone())
            .collect()
    }

    /// SHA-256 of the arguments, so different arguments cannot share an approval through a hash collision.
    fn compute_hash(&self, arguments: &str) -> String {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(arguments.as_bytes()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager(enabled: bool, critical: &[&str], required: u32) -> ConsensusManager {
        ConsensusManager::new(ConsensusConfig {
            enabled,
            critical_tools: critical.iter().map(|s| s.to_string()).collect(),
            required_signatures: required,
            ..Default::default()
        })
    }

    use std::sync::Mutex;

    fn manager_with_clock(ttl: u64) -> (ConsensusManager, Arc<Mutex<DateTime<Utc>>>) {
        let now = Arc::new(Mutex::new(Utc::now()));
        let handle = now.clone();
        let mgr = ConsensusManager::with_clock(
            ConsensusConfig {
                enabled: true,
                critical_tools: vec!["delete_file".to_string()],
                required_signatures: 2,
                pending_ttl_secs: ttl,
                ..Default::default()
            },
            Arc::new(move || *handle.lock().unwrap()),
        );
        (mgr, now)
    }

    fn advance(now: &Arc<Mutex<DateTime<Utc>>>, secs: i64) {
        let mut t = now.lock().unwrap();
        *t += chrono::Duration::seconds(secs);
    }

    #[test]
    fn default_ttl_is_fifteen_minutes() {
        assert_eq!(ConsensusConfig::default().pending_ttl_secs, 900);
    }

    #[test]
    fn action_is_valid_before_the_ttl_and_expired_after() {
        let (mgr, now) = manager_with_clock(60);
        let id = propose(&mgr, "delete_file", "{}");
        advance(&now, 59);
        assert_eq!(mgr.get_status(&id), Some(ActionStatus::Pending));
        assert_eq!(mgr.list_pending().len(), 1);
        advance(&now, 1);
        assert_eq!(mgr.get_status(&id), Some(ActionStatus::Expired));
        assert!(mgr.list_pending().is_empty());
    }

    #[test]
    fn expired_action_cannot_be_signed_or_approved() {
        let (mgr, now) = manager_with_clock(60);
        let id = propose(&mgr, "delete_file", "{}");
        mgr.sign_action(&id, WitnessType::NeuralJudge).unwrap();
        advance(&now, 61);
        let err = mgr
            .sign_action(&id, WitnessType::HumanAdmin("alice".into()))
            .unwrap_err();
        assert!(err.contains("not found"));
        assert_eq!(mgr.get_status(&id), None);
    }

    #[test]
    fn approved_action_expires_before_it_is_used() {
        let (mgr, now) = manager_with_clock(60);
        let id = propose(&mgr, "delete_file", "{}");
        mgr.sign_action(&id, WitnessType::NeuralJudge).unwrap();
        let status = mgr
            .sign_action(&id, WitnessType::HumanAdmin("alice".into()))
            .unwrap();
        assert_eq!(status, ActionStatus::Approved);
        advance(&now, 60);
        assert!(!mgr.check_approval("ns-a", "agent-1", "delete_file", "{}"));
    }

    #[test]
    fn approved_action_within_the_ttl_is_still_consumed_once() {
        let (mgr, now) = manager_with_clock(60);
        let id = propose(&mgr, "delete_file", "{}");
        mgr.sign_action(&id, WitnessType::NeuralJudge).unwrap();
        mgr.sign_action(&id, WitnessType::HumanAdmin("alice".into()))
            .unwrap();
        advance(&now, 30);
        assert!(mgr.check_approval("ns-a", "agent-1", "delete_file", "{}"));
        assert!(!mgr.check_approval("ns-a", "agent-1", "delete_file", "{}"));
    }

    #[test]
    fn expired_actions_are_purged_when_a_new_one_is_proposed() {
        let (mgr, now) = manager_with_clock(60);
        for _ in 0..5 {
            propose(&mgr, "delete_file", "{}");
        }
        assert_eq!(mgr.pending.len(), 5);
        advance(&now, 61);
        let fresh = propose(&mgr, "delete_file", "{}");
        assert_eq!(mgr.pending.len(), 1);
        assert_eq!(mgr.get_status(&fresh), Some(ActionStatus::Pending));
    }

    #[test]
    fn zero_ttl_uses_the_default() {
        let (mgr, now) = manager_with_clock(0);
        let id = propose(&mgr, "delete_file", "{}");
        advance(&now, 899);
        assert_eq!(mgr.get_status(&id), Some(ActionStatus::Pending));
        advance(&now, 1);
        assert_eq!(mgr.get_status(&id), Some(ActionStatus::Expired));
    }

    fn propose(mgr: &ConsensusManager, tool: &str, args: &str) -> String {
        mgr.propose_action("ns-a", "agent-1", tool, args)
            .expect("critical tool should be registered")
    }

    #[test]
    fn disabled_config_never_registers_actions() {
        let mgr = manager(false, &["delete_file"], 2);
        assert!(mgr
            .propose_action("ns-a", "agent-1", "delete_file", "{}")
            .is_none());
        assert!(mgr.list_pending().is_empty());
    }

    #[test]
    fn non_critical_tool_is_not_registered() {
        let mgr = manager(true, &["delete_file"], 2);
        assert!(mgr
            .propose_action("ns-a", "agent-1", "read_file", "{}")
            .is_none());
        assert!(mgr.list_pending().is_empty());
    }

    #[test]
    fn exact_critical_tool_is_registered_as_pending() {
        let mgr = manager(true, &["delete_file"], 2);
        let id = propose(&mgr, "delete_file", "{}");
        assert_eq!(mgr.get_status(&id), Some(ActionStatus::Pending));
        let pending = mgr.list_pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, id);
        assert_eq!(pending[0].required_m, 2);
        assert!(pending[0].signatures.is_empty());
    }

    #[test]
    fn exact_pattern_does_not_match_longer_or_shorter_names() {
        let mgr = manager(true, &["delete_file"], 1);
        assert!(mgr
            .propose_action("ns-a", "agent-1", "delete_file2", "{}")
            .is_none());
        assert!(mgr
            .propose_action("ns-a", "agent-1", "delete", "{}")
            .is_none());
    }

    #[test]
    fn trailing_wildcard_matches_by_prefix() {
        let mgr = manager(true, &["admin:*"], 1);
        assert!(mgr
            .propose_action("ns-a", "agent-1", "admin:delete", "{}")
            .is_some());
        assert!(mgr
            .propose_action("ns-a", "agent-1", "admin:", "{}")
            .is_some());
        assert!(mgr
            .propose_action("ns-a", "agent-1", "admin", "{}")
            .is_none());
        assert!(mgr
            .propose_action("ns-a", "agent-1", "adminx", "{}")
            .is_none());
    }

    #[test]
    fn bare_wildcard_matches_every_tool() {
        let mgr = manager(true, &["*"], 1);
        assert!(mgr
            .propose_action("ns-a", "agent-1", "anything", "{}")
            .is_some());
        assert!(mgr.propose_action("ns-a", "agent-1", "", "{}").is_some());
    }

    #[test]
    fn signing_unknown_action_is_an_error() {
        let mgr = manager(true, &["x"], 1);
        let err = mgr
            .sign_action("missing", WitnessType::NeuralJudge)
            .unwrap_err();
        assert_eq!(err, "Action not found or already processed");
    }

    #[test]
    fn approval_is_reached_exactly_at_the_threshold() {
        let mgr = manager(true, &["x"], 2);
        let id = propose(&mgr, "x", "{}");
        let first = mgr
            .sign_action(&id, WitnessType::DeterministicPolicy("p1".into()))
            .unwrap();
        assert_eq!(first, ActionStatus::Pending);
        let second = mgr
            .sign_action(&id, WitnessType::HumanAdmin("alice".into()))
            .unwrap();
        assert_eq!(second, ActionStatus::Approved);
    }

    #[test]
    fn one_signature_below_threshold_stays_pending() {
        let mgr = manager(true, &["x"], 3);
        let id = propose(&mgr, "x", "{}");
        mgr.sign_action(&id, WitnessType::NeuralJudge).unwrap();
        let status = mgr
            .sign_action(&id, WitnessType::HumanAdmin("bob".into()))
            .unwrap();
        assert_eq!(status, ActionStatus::Pending);
        let status = mgr
            .sign_action(&id, WitnessType::DeterministicPolicy("p".into()))
            .unwrap();
        assert_eq!(status, ActionStatus::Approved);
    }

    #[test]
    fn duplicate_witness_of_same_kind_is_counted_once() {
        let mgr = manager(true, &["x"], 2);
        let id = propose(&mgr, "x", "{}");
        mgr.sign_action(&id, WitnessType::DeterministicPolicy("p".into()))
            .unwrap();
        let status = mgr
            .sign_action(&id, WitnessType::DeterministicPolicy("p".into()))
            .unwrap();
        assert_eq!(status, ActionStatus::Pending);
        assert_eq!(mgr.list_pending()[0].signatures.len(), 1);
    }

    #[test]
    fn different_policy_names_and_witness_kinds_are_distinct() {
        let mgr = manager(true, &["x"], 2);
        let id = propose(&mgr, "x", "{}");
        mgr.sign_action(&id, WitnessType::DeterministicPolicy("p1".into()))
            .unwrap();
        let status = mgr
            .sign_action(&id, WitnessType::DeterministicPolicy("p2".into()))
            .unwrap();
        assert_eq!(status, ActionStatus::Approved);

        let mgr = manager(true, &["x"], 2);
        let id = propose(&mgr, "x", "{}");
        mgr.sign_action(&id, WitnessType::DeterministicPolicy("alice".into()))
            .unwrap();
        let status = mgr
            .sign_action(&id, WitnessType::HumanAdmin("alice".into()))
            .unwrap();
        assert_eq!(status, ActionStatus::Approved);
    }

    #[test]
    fn human_admins_are_deduplicated_by_user() {
        let mgr = manager(true, &["x"], 2);
        let id = propose(&mgr, "x", "{}");
        mgr.sign_action(&id, WitnessType::HumanAdmin("alice".into()))
            .unwrap();
        let status = mgr
            .sign_action(&id, WitnessType::HumanAdmin("alice".into()))
            .unwrap();
        assert_eq!(status, ActionStatus::Pending);
        let status = mgr
            .sign_action(&id, WitnessType::HumanAdmin("bob".into()))
            .unwrap();
        assert_eq!(status, ActionStatus::Approved);
    }

    #[test]
    fn neural_judge_counts_once() {
        let mgr = manager(true, &["x"], 2);
        let id = propose(&mgr, "x", "{}");
        mgr.sign_action(&id, WitnessType::NeuralJudge).unwrap();
        let status = mgr.sign_action(&id, WitnessType::NeuralJudge).unwrap();
        assert_eq!(status, ActionStatus::Pending);
        let status = mgr
            .sign_action(&id, WitnessType::HumanAdmin("carol".into()))
            .unwrap();
        assert_eq!(status, ActionStatus::Approved);
    }

    #[test]
    fn zero_required_signatures_approves_on_first_signature() {
        let mgr = manager(true, &["x"], 0);
        let id = propose(&mgr, "x", "{}");
        let status = mgr.sign_action(&id, WitnessType::NeuralJudge).unwrap();
        assert_eq!(status, ActionStatus::Approved);
    }

    #[test]
    fn denied_action_is_not_authorized() {
        let mgr = manager(true, &["x"], 1);
        let id = propose(&mgr, "x", "{}");
        mgr.deny_action(&id, "policy said no").unwrap();
        assert_eq!(mgr.get_status(&id), None);
        assert!(!mgr.check_approval("ns-a", "agent-1", "x", "{}"));
        assert!(mgr.list_pending().is_empty());
    }

    #[test]
    fn denying_unknown_action_is_an_error() {
        let mgr = manager(true, &["x"], 1);
        assert_eq!(
            mgr.deny_action("missing", "reason").unwrap_err(),
            "Action not found"
        );
    }

    #[test]
    fn approved_action_authorizes_exactly_once() {
        let mgr = manager(true, &["x"], 1);
        let id = propose(&mgr, "x", r#"{"path":"/a"}"#);
        mgr.sign_action(&id, WitnessType::NeuralJudge).unwrap();
        assert!(mgr.check_approval("ns-a", "agent-1", "x", r#"{"path":"/a"}"#));
        assert!(!mgr.check_approval("ns-a", "agent-1", "x", r#"{"path":"/a"}"#));
        assert_eq!(mgr.get_status(&id), None);
    }

    #[test]
    fn approval_does_not_match_other_agent_tool_or_arguments() {
        let mgr = manager(true, &["x"], 1);
        let id = propose(&mgr, "x", "{}");
        mgr.sign_action(&id, WitnessType::NeuralJudge).unwrap();
        assert!(!mgr.check_approval("ns-a", "agent-2", "x", "{}"));
        assert!(!mgr.check_approval("ns-a", "agent-1", "y", "{}"));
        assert!(!mgr.check_approval("ns-a", "agent-1", "x", "{ }"));
        // Mismatched requests must not consume the approval.
        assert!(mgr.check_approval("ns-a", "agent-1", "x", "{}"));
    }

    #[test]
    fn pending_action_does_not_authorize_and_keeps_its_status() {
        let mgr = manager(true, &["x"], 2);
        let id = propose(&mgr, "x", "{}");
        assert!(!mgr.check_approval("ns-a", "agent-1", "x", "{}"));
        assert_eq!(mgr.get_status(&id), Some(ActionStatus::Pending));
        assert_eq!(mgr.get_status("missing"), None);
    }

    #[test]
    fn signing_a_denied_action_must_not_approve_it() {
        let mgr = manager(true, &["x"], 1);
        let id = propose(&mgr, "x", "{}");
        mgr.deny_action(&id, "no").unwrap();
        let err = mgr.sign_action(&id, WitnessType::NeuralJudge).unwrap_err();
        assert_eq!(err, "Action not found or already processed");
        assert_eq!(mgr.get_status(&id), None);
        assert!(!mgr.check_approval("ns-a", "agent-1", "x", "{}"));
    }

    #[test]
    fn signing_an_approved_action_changes_nothing() {
        let mgr = manager(true, &["x"], 1);
        let id = propose(&mgr, "x", "{}");
        mgr.sign_action(&id, WitnessType::NeuralJudge).unwrap();
        assert!(mgr
            .sign_action(&id, WitnessType::HumanAdmin("dave".into()))
            .is_err());
        assert_eq!(mgr.get_status(&id), Some(ActionStatus::Approved));
    }

    #[test]
    fn denying_an_approved_action_is_rejected() {
        let mgr = manager(true, &["x"], 1);
        let id = propose(&mgr, "x", "{}");
        mgr.sign_action(&id, WitnessType::NeuralJudge).unwrap();
        assert!(mgr.deny_action(&id, "too late").is_err());
        assert_eq!(mgr.get_status(&id), Some(ActionStatus::Approved));
        assert!(mgr.check_approval("ns-a", "agent-1", "x", "{}"));
    }

    #[test]
    fn denied_actions_are_purged_and_do_not_pile_up() {
        let mgr = manager(true, &["x"], 1);
        for i in 0..50 {
            let id = propose(&mgr, "x", &format!("{{\"n\":{i}}}"));
            mgr.deny_action(&id, "no").unwrap();
        }
        assert!(mgr.pending.is_empty());
    }

    #[test]
    fn denying_twice_is_an_error() {
        let mgr = manager(true, &["x"], 1);
        let id = propose(&mgr, "x", "{}");
        mgr.deny_action(&id, "no").unwrap();
        assert!(mgr.deny_action(&id, "again").is_err());
    }

    #[test]
    fn denial_leaves_other_pending_actions_untouched() {
        let mgr = manager(true, &["x"], 1);
        let a = propose(&mgr, "x", "{\"a\":1}");
        let b = propose(&mgr, "x", "{\"b\":2}");
        mgr.deny_action(&a, "no").unwrap();
        assert_eq!(mgr.get_status(&b), Some(ActionStatus::Pending));
        assert_eq!(mgr.list_pending().len(), 1);
    }

    #[test]
    fn concurrent_checks_consume_an_approval_only_once() {
        let mgr = manager(true, &["x"], 1);
        let id = propose(&mgr, "x", "{}");
        mgr.sign_action(&id, WitnessType::NeuralJudge).unwrap();
        let granted = std::thread::scope(|s| {
            let handles: Vec<_> = (0..8)
                .map(|_| s.spawn(|| mgr.check_approval("ns-a", "agent-1", "x", "{}")))
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap())
                .filter(|&ok| ok)
                .count()
        });
        assert_eq!(granted, 1);
    }

    #[test]
    fn an_approval_is_bound_to_its_namespace() {
        let mgr = manager(true, &["delete_file"], 1);
        let id = mgr
            .propose_action("ns-a", "agent-1", "delete_file", "{}")
            .expect("critical tool should be registered");
        mgr.sign_action(&id, WitnessType::HumanAdmin("alice".into()))
            .unwrap();
        assert!(!mgr.check_approval("ns-b", "agent-1", "delete_file", "{}"));
        assert!(mgr.check_approval("ns-a", "agent-1", "delete_file", "{}"));
    }

    #[test]
    fn the_arguments_hash_is_sha256() {
        let mgr = manager(true, &["delete_file"], 1);
        mgr.propose_action("ns-a", "agent-1", "delete_file", "abc")
            .expect("critical tool should be registered");
        let pending = mgr.list_pending();
        assert_eq!(pending[0].namespace, "ns-a");
        assert_eq!(
            pending[0].arguments_hash,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn default_cap_is_one_thousand_pending_actions() {
        assert_eq!(mgr_default_cap(), 1_000);
    }

    fn mgr_default_cap() -> usize {
        ConsensusManager::new(ConsensusConfig::default()).max_pending
    }

    fn capped_mgr(cap: usize) -> (ConsensusManager, Arc<std::sync::Mutex<DateTime<Utc>>>) {
        let now = Arc::new(std::sync::Mutex::new(Utc::now()));
        let c = Arc::clone(&now);
        let mgr = ConsensusManager::with_clock(
            ConsensusConfig {
                enabled: true,
                critical_tools: vec!["deploy".to_string()],
                required_signatures: 1,
                pending_ttl_secs: 900,
                ..ConsensusConfig::default()
            },
            Arc::new(move || *c.lock().unwrap()),
        )
        .with_max_pending(cap);
        (mgr, now)
    }

    #[test]
    fn pending_cap_is_respected_and_the_oldest_goes_first() {
        let (mgr, now) = capped_mgr(5);
        let mut ids = Vec::new();
        for _ in 0..20 {
            *now.lock().unwrap() += chrono::Duration::seconds(1);
            ids.push(mgr.propose_action("ns", "agent", "deploy", "{}").unwrap());
            assert!(mgr.pending.len() <= 5);
        }
        assert_eq!(mgr.pending.len(), 5);
        assert!(!mgr.pending.contains_key(&ids[0]));
        assert!(mgr.pending.contains_key(&ids[19]), "the newest is kept");
        assert!(mgr.pending.contains_key(&ids[15]));
    }

    #[test]
    fn expired_actions_are_purged_before_live_ones_are_dropped() {
        let (mgr, now) = capped_mgr(3);
        let first = mgr.propose_action("ns", "agent", "deploy", "{}").unwrap();
        *now.lock().unwrap() += chrono::Duration::seconds(1000);
        let live1 = mgr.propose_action("ns", "agent", "deploy", "{}").unwrap();
        let live2 = mgr.propose_action("ns", "agent", "deploy", "{}").unwrap();
        let live3 = mgr.propose_action("ns", "agent", "deploy", "{}").unwrap();
        assert!(!mgr.pending.contains_key(&first));
        for id in [live1, live2, live3] {
            assert!(mgr.pending.contains_key(&id));
        }
    }
}
