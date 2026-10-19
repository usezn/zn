use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Protocol Constants
pub const METHOD_SEND: &str = "tasks/send";
pub const METHOD_GET: &str = "tasks/get";
pub const METHOD_LIST: &str = "tasks/list";
pub const METHOD_CANCEL: &str = "tasks/cancel";

/// A2A JSON-RPC Request Params
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A2AParams {
    /// Target Agent ID or Topic
    pub recipient: String,
    /// The actual task payload
    pub task: Value,
    /// Optional urgency level (low, normal, high, critical)
    pub priority: Option<String>,
    /// Optional correlation ID for threads
    pub thread_id: Option<String>,
}

/// Helper to validate if a string is a known A2A method
pub fn is_a2a_method(method: &str) -> bool {
    matches!(
        method,
        METHOD_SEND | METHOD_GET | METHOD_LIST | METHOD_CANCEL
    )
}

/// Resolves the "virtual tool name" for policy checking
///
/// Strategies:
/// - Exact Route: a2a:send:finance-agent
/// - Action Only: a2a:send
/// - Wildcard Recipient: a2a:send:*
pub fn resolve_policy_context(method: &str, params: &Value) -> String {
    let action = method.trim_start_matches("tasks/");

    // Extract recipient safely
    let recipient = params
        .get("recipient")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());

    match recipient {
        Some(target) => format!("a2a:{}:{}", action, target),
        None => format!("a2a:{}", action),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recognises_all_known_methods() {
        for m in [METHOD_SEND, METHOD_GET, METHOD_LIST, METHOD_CANCEL] {
            assert!(is_a2a_method(m), "{m} should be an A2A method");
        }
    }

    #[test]
    fn rejects_unknown_or_malformed_methods() {
        for m in [
            "",
            "tasks",
            "tasks/",
            "tasks/SEND",
            "tools/call",
            " tasks/send",
        ] {
            assert!(!is_a2a_method(m), "{m:?} should not be an A2A method");
        }
    }

    #[test]
    fn policy_context_with_recipient() {
        let ctx = resolve_policy_context(METHOD_SEND, &json!({"recipient": "finance-agent"}));
        assert_eq!(ctx, "a2a:send:finance-agent");
    }

    #[test]
    fn policy_context_without_recipient() {
        assert_eq!(resolve_policy_context(METHOD_GET, &json!({})), "a2a:get");
        assert_eq!(
            resolve_policy_context(METHOD_LIST, &Value::Null),
            "a2a:list"
        );
    }

    #[test]
    fn policy_context_ignores_empty_or_non_string_recipient() {
        assert_eq!(
            resolve_policy_context(METHOD_CANCEL, &json!({"recipient": ""})),
            "a2a:cancel"
        );
        assert_eq!(
            resolve_policy_context(METHOD_SEND, &json!({"recipient": 42})),
            "a2a:send"
        );
    }

    #[test]
    fn policy_context_handles_method_without_prefix() {
        assert_eq!(
            resolve_policy_context("send", &json!({"recipient": "bot"})),
            "a2a:send:bot"
        );
    }

    #[test]
    fn params_roundtrip_with_optional_fields() {
        let params = A2AParams {
            recipient: "agent-a".to_string(),
            task: json!({"op": "ping"}),
            priority: Some("high".to_string()),
            thread_id: None,
        };
        let text = serde_json::to_string(&params).unwrap();
        let back: A2AParams = serde_json::from_str(&text).unwrap();
        assert_eq!(back.recipient, "agent-a");
        assert_eq!(back.task, json!({"op": "ping"}));
        assert_eq!(back.priority.as_deref(), Some("high"));
        assert!(back.thread_id.is_none());
    }

    #[test]
    fn params_deserialize_without_optional_fields() {
        let p: A2AParams = serde_json::from_value(json!({"recipient": "x", "task": {}})).unwrap();
        assert!(p.priority.is_none() && p.thread_id.is_none());
    }

    #[test]
    fn params_require_recipient_and_task() {
        assert!(serde_json::from_value::<A2AParams>(json!({"task": {}})).is_err());
        assert!(serde_json::from_value::<A2AParams>(json!({"recipient": "x"})).is_err());
    }
}
