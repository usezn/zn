use super::rules::fold_system1;
use crate::config::ConsensusConfig;
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

/// Normalise a tool name for critical-tool matching: strip invisible and
/// format characters, fold fullwidth and common homoglyphs, then lowercase.
fn fold_tool_name(name: &str) -> String {
    let visible: String = name
        .chars()
        .filter(|c| {
            !matches!(
                *c,
                '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{180E}' | '\u{2060}'..='\u{2064}'
                | '\u{FE00}'..='\u{FE0F}'
            ) && !c.is_control()
        })
        .collect();
    fold_system1(&visible).to_lowercase()
}

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
pub struct ConsensusManager {
    /// Pending actions: action_id -> Action
    pending: DashMap<String, AuthorizableAction>,
    config: ConsensusConfig,
    clock: Clock,
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
        }
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
        agent_id: &str,
        tool_name: &str,
        arguments: &str,
    ) -> Option<String> {
        if !self.config.enabled {
            return None;
        }
        self.purge_expired();

        // Check if tool is critical (supports wildcards). Both sides go through
        // the same fold, so case and unicode variants cannot skip consensus.
        let folded_tool = fold_tool_name(tool_name);
        let is_critical = self.config.critical_tools.iter().any(|pattern| {
            let pattern = fold_tool_name(pattern);
            match pattern.strip_suffix('*') {
                Some(prefix) => folded_tool.starts_with(prefix),
                None => folded_tool == pattern,
            }
        });

        if !is_critical {
            return None;
        }

        let args_hash = self.compute_hash(arguments);

        let action_id = Uuid::new_v4().to_string();
        let action = AuthorizableAction {
            id: action_id.clone(),
            agent_id: agent_id.to_string(),
            tool_name: tool_name.to_string(),
            arguments_hash: args_hash,
            timestamp: self.now(),
            signatures: Vec::new(),
            required_m: self.config.required_signatures,
            status: ActionStatus::Pending,
        };

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

    /// Check if a specific action has been approved and matches the current request
    pub fn check_approval(&self, agent_id: &str, tool_name: &str, arguments: &str) -> bool {
        self.purge_expired();
        let hash = self.compute_hash(arguments);

        // Find matching approved action
        // Linear scan for simplicity; swap in a proper index if this path gets hot.
        let mut approved_id = None;
        for entry in self.pending.iter() {
            let action = entry.value();
            if action.status == ActionStatus::Approved
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

    fn compute_hash(&self, arguments: &str) -> String {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        arguments.hash(&mut hasher);
        format!("{:x}", hasher.finish())
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
        assert!(!mgr.check_approval("agent-1", "delete_file", "{}"));
    }

    #[test]
    fn approved_action_within_the_ttl_is_still_consumed_once() {
        let (mgr, now) = manager_with_clock(60);
        let id = propose(&mgr, "delete_file", "{}");
        mgr.sign_action(&id, WitnessType::NeuralJudge).unwrap();
        mgr.sign_action(&id, WitnessType::HumanAdmin("alice".into()))
            .unwrap();
        advance(&now, 30);
        assert!(mgr.check_approval("agent-1", "delete_file", "{}"));
        assert!(!mgr.check_approval("agent-1", "delete_file", "{}"));
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
        mgr.propose_action("agent-1", tool, args)
            .expect("critical tool should be registered")
    }

    #[test]
    fn disabled_config_never_registers_actions() {
        let mgr = manager(false, &["delete_file"], 2);
        assert!(mgr.propose_action("agent-1", "delete_file", "{}").is_none());
        assert!(mgr.list_pending().is_empty());
    }

    #[test]
    fn non_critical_tool_is_not_registered() {
        let mgr = manager(true, &["delete_file"], 2);
        assert!(mgr.propose_action("agent-1", "read_file", "{}").is_none());
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
            .propose_action("agent-1", "delete_file2", "{}")
            .is_none());
        assert!(mgr.propose_action("agent-1", "delete", "{}").is_none());
    }

    #[test]
    fn trailing_wildcard_matches_by_prefix() {
        let mgr = manager(true, &["admin:*"], 1);
        assert!(mgr
            .propose_action("agent-1", "admin:delete", "{}")
            .is_some());
        assert!(mgr.propose_action("agent-1", "admin:", "{}").is_some());
        assert!(mgr.propose_action("agent-1", "admin", "{}").is_none());
        assert!(mgr.propose_action("agent-1", "adminx", "{}").is_none());
    }

    #[test]
    fn bare_wildcard_matches_every_tool() {
        let mgr = manager(true, &["*"], 1);
        assert!(mgr.propose_action("agent-1", "anything", "{}").is_some());
        assert!(mgr.propose_action("agent-1", "", "{}").is_some());
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
        assert!(!mgr.check_approval("agent-1", "x", "{}"));
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
        assert!(mgr.check_approval("agent-1", "x", r#"{"path":"/a"}"#));
        assert!(!mgr.check_approval("agent-1", "x", r#"{"path":"/a"}"#));
        assert_eq!(mgr.get_status(&id), None);
    }

    #[test]
    fn approval_does_not_match_other_agent_tool_or_arguments() {
        let mgr = manager(true, &["x"], 1);
        let id = propose(&mgr, "x", "{}");
        mgr.sign_action(&id, WitnessType::NeuralJudge).unwrap();
        assert!(!mgr.check_approval("agent-2", "x", "{}"));
        assert!(!mgr.check_approval("agent-1", "y", "{}"));
        assert!(!mgr.check_approval("agent-1", "x", "{ }"));
        // Mismatched requests must not consume the approval.
        assert!(mgr.check_approval("agent-1", "x", "{}"));
    }

    #[test]
    fn pending_action_does_not_authorize_and_keeps_its_status() {
        let mgr = manager(true, &["x"], 2);
        let id = propose(&mgr, "x", "{}");
        assert!(!mgr.check_approval("agent-1", "x", "{}"));
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
        assert!(!mgr.check_approval("agent-1", "x", "{}"));
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
        assert!(mgr.check_approval("agent-1", "x", "{}"));
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
                .map(|_| s.spawn(|| mgr.check_approval("agent-1", "x", "{}")))
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
    fn critical_tool_match_ignores_case_and_unicode_variants() {
        let mgr = manager(true, &["delete_user", "Admin:*"], 2);
        for name in [
            "delete_user",
            "DELETE_USER",
            "Delete_User",
            "ｄｅｌｅｔｅ_ｕｓｅｒ",
            "delete\u{200D}_user",
            "del\u{2060}ete_user",
            "ADMIN:wipe",
            "ａdmin:wipe",
        ] {
            assert!(
                mgr.propose_action("agent-1", name, "{}").is_some(),
                "{name:?} must need consensus"
            );
        }
    }

    #[test]
    fn non_critical_tool_unchanged_by_fold() {
        let mgr = manager(true, &["delete_user"], 2);
        assert!(mgr.propose_action("agent-1", "Read_File", "{}").is_none());
        assert!(mgr
            .propose_action("agent-1", "delete_users", "{}")
            .is_none());
    }
}
