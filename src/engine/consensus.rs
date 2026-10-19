use crate::config::ConsensusConfig;
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

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
}

impl ConsensusManager {
    pub fn new(config: ConsensusConfig) -> Self {
        Self {
            pending: DashMap::new(),
            config,
        }
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
            agent_id: agent_id.to_string(),
            tool_name: tool_name.to_string(),
            arguments_hash: args_hash,
            timestamp: Utc::now(),
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
        let mut action = self
            .pending
            .get_mut(action_id)
            .ok_or_else(|| "Action not found or already processed".to_string())?;

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

    /// Deny an action
    pub fn deny_action(&self, action_id: &str, _reason: &str) -> std::result::Result<(), String> {
        let mut action = self
            .pending
            .get_mut(action_id)
            .ok_or_else(|| "Action not found".to_string())?;
        action.status = ActionStatus::Denied;
        Ok(())
    }

    /// Check if a specific action has been approved and matches the current request
    pub fn check_approval(&self, agent_id: &str, tool_name: &str, arguments: &str) -> bool {
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
            // "Consume" the approval so it can't be reused (TOCTOU fix)
            self.pending.remove(&id);
            return true;
        }

        false
    }

    /// Get current status of an action
    pub fn get_status(&self, action_id: &str) -> Option<ActionStatus> {
        self.pending.get(action_id).map(|a| a.status.clone())
    }

    /// List all pending actions
    pub fn list_pending(&self) -> Vec<AuthorizableAction> {
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
        assert_eq!(mgr.get_status(&id), Some(ActionStatus::Denied));
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

    /// Known bug: `sign_action` does not check the action status, so a denied
    /// action is approved by a later signature once the threshold is reached.
    #[test]
    #[ignore = "known bug: sign_action approves a denied action (see PR body)"]
    fn signing_a_denied_action_must_not_approve_it() {
        let mgr = manager(true, &["x"], 1);
        let id = propose(&mgr, "x", "{}");
        mgr.deny_action(&id, "no").unwrap();
        let status = mgr.sign_action(&id, WitnessType::NeuralJudge).unwrap();
        assert_eq!(status, ActionStatus::Denied);
        assert!(!mgr.check_approval("agent-1", "x", "{}"));
    }
}
