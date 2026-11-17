//! REST API Handlers
//!
//! Contains all REST API endpoints for the zn Management API.

use axum::{extract::State, http::StatusCode, response::Json, Extension};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::audit::AuditVault;
use crate::engine::ZnEngine;
use crate::tenants::{TenantContext, TenantRole, TenantStore};

/// Shared application state for handlers
#[derive(Clone)]
pub struct ApiState {
    pub vault: Arc<AuditVault>,
    pub engine: Arc<ZnEngine>,
    pub tenants: Arc<TenantStore>,
    pub consensus: Arc<crate::engine::consensus::ConsensusManager>,
}

// ============================================
// Health & Status
// ============================================

/// Health check endpoint
pub async fn health() -> &'static str {
    "OK"
}

/// Stats endpoint - returns audit statistics
pub async fn stats(
    State(state): State<ApiState>,
    Extension(tenant): Extension<TenantContext>,
) -> Json<Value> {
    let stats_result = if tenant.role == TenantRole::SuperAdmin {
        state.vault.stats()
    } else {
        state.vault.stats_by_namespace(&tenant.namespace)
    };

    match stats_result {
        Ok(stats) => Json(json!({
            "status": "ok",
            "stats": {
                "total": stats.total,
                "allowed": stats.allowed,
                "denied": stats.denied,
                "allow_rate": if stats.total > 0 {
                    (stats.allowed as f64 / stats.total as f64 * 100.0).round()
                } else {
                    100.0
                }
            }
        })),
        Err(e) => Json(json!({
            "status": "error",
            "error": e.to_string()
        })),
    }
}

// ============================================
// Audit Logs
// ============================================

/// Recent logs endpoint - returns last N audit entries
pub async fn logs(
    State(state): State<ApiState>,
    Extension(tenant): Extension<TenantContext>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Json<Value> {
    let limit: usize = params
        .get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(50)
        .min(500);

    let logs_result = if tenant.role == TenantRole::SuperAdmin {
        state.vault.get_recent(limit)
    } else {
        state
            .vault
            .get_recent_by_namespace(&tenant.namespace, limit)
    };

    match logs_result {
        Ok(entries) => Json(json!({
            "status": "ok",
            "count": entries.len(),
            "entries": entries
        })),
        Err(e) => Json(json!({
            "status": "error",
            "error": e.to_string()
        })),
    }
}

// ============================================
// Policy Management (SuperAdmin only)
// ============================================

/// List active policies endpoint (SuperAdmin only)
pub async fn policies_list(
    State(state): State<ApiState>,
    Extension(tenant): Extension<TenantContext>,
) -> Json<Value> {
    if tenant.role != TenantRole::SuperAdmin {
        return Json(json!({
            "status": "error",
            "error": "Forbidden: SuperAdmin role required"
        }));
    }

    let policies = state.engine.list_policies();
    Json(json!({
        "status": "ok",
        "count": policies.len(),
        "entries": policies
    }))
}

// ============================================
// Tenant Management
// ============================================

#[derive(serde::Deserialize)]
pub struct CreateTenantRequest {
    pub name: String,
    pub namespace: String,
    pub api_key: String,
}

/// Create a new tenant (SuperAdmin only). Answers 403 to other roles and
/// 400 when the tenant cannot be created (for example an invalid namespace,
/// a blank key, or a name, namespace or key already in use).
pub async fn tenants_create(
    State(state): State<ApiState>,
    Extension(tenant): Extension<TenantContext>,
    axum::Json(payload): axum::Json<CreateTenantRequest>,
) -> (StatusCode, Json<Value>) {
    if tenant.role != TenantRole::SuperAdmin {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "status": "error",
                "error": "Forbidden: SuperAdmin role required"
            })),
        );
    }

    match state
        .tenants
        .create_tenant(&payload.name, &payload.namespace, &payload.api_key)
    {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({
                "status": "ok",
                "message": "Tenant created successfully"
            })),
        ),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "status": "error",
                "error": e.to_string()
            })),
        ),
    }
}

/// List all tenants (SuperAdmin only)
pub async fn tenants_list(
    State(state): State<ApiState>,
    Extension(tenant): Extension<TenantContext>,
) -> Json<Value> {
    if tenant.role != TenantRole::SuperAdmin {
        return Json(json!({
            "status": "error",
            "error": "Forbidden: SuperAdmin role required"
        }));
    }

    match state.tenants.list_tenants() {
        Ok(tenants) => Json(json!({
            "status": "ok",
            "count": tenants.len(),
            "tenants": tenants
        })),
        Err(e) => Json(json!({
            "status": "error",
            "error": e.to_string()
        })),
    }
}

// ============================================
// Consensus Management (M-of-N, SuperAdmin only)
// ============================================

/// List pending authorizations (SuperAdmin only)
pub async fn consensus_list(
    State(state): State<ApiState>,
    Extension(tenant): Extension<TenantContext>,
) -> Json<Value> {
    if tenant.role != TenantRole::SuperAdmin {
        return Json(json!({
            "status": "error",
            "error": "Forbidden: SuperAdmin role required"
        }));
    }

    let pending = state.consensus.list_pending();
    Json(json!({
        "status": "ok",
        "count": pending.len(),
        "entries": pending
    }))
}

#[derive(serde::Deserialize)]
pub struct SignRequest {
    pub action_id: String,
    pub witness_name: Option<String>,
}

/// Sign a pending action (as a Human Admin, SuperAdmin only)
pub async fn consensus_sign(
    State(state): State<ApiState>,
    Extension(tenant): Extension<TenantContext>,
    axum::Json(payload): axum::Json<SignRequest>,
) -> Json<Value> {
    if tenant.role != TenantRole::SuperAdmin {
        return Json(json!({
            "status": "error",
            "error": "Forbidden: SuperAdmin role required"
        }));
    }

    use crate::engine::consensus::WitnessType;

    let witness = WitnessType::HumanAdmin(tenant.name);
    match state.consensus.sign_action(&payload.action_id, witness) {
        Ok(status) => Json(json!({
            "status": "ok",
            "action_status": status
        })),
        Err(e) => Json(json!({
            "status": "error",
            "error": e
        })),
    }
}

#[derive(serde::Deserialize)]
pub struct DenyRequest {
    pub action_id: String,
    pub reason: String,
}

/// Deny a pending action (SuperAdmin only)
pub async fn consensus_deny(
    State(state): State<ApiState>,
    Extension(tenant): Extension<TenantContext>,
    axum::Json(payload): axum::Json<DenyRequest>,
) -> Json<Value> {
    if tenant.role != TenantRole::SuperAdmin {
        return Json(json!({
            "status": "error",
            "error": "Forbidden: SuperAdmin role required"
        }));
    }

    match state
        .consensus
        .deny_action(&payload.action_id, &payload.reason)
    {
        Ok(_) => Json(json!({
            "status": "ok",
            "message": "Action denied"
        })),
        Err(e) => Json(json!({
            "status": "error",
            "error": e
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ConsensusConfig;
    use crate::engine::ZnEngineConfig;
    use rusqlite::Connection;
    use std::sync::Mutex;

    fn setup_test_state() -> ApiState {
        let vault = Arc::new(AuditVault::new(":memory:", None).expect("vault init"));
        let engine = Arc::new(
            ZnEngine::new(ZnEngineConfig {
                gas_limit: 10_000_000,
                memory_limit: 10 * 1024 * 1024,
                timeout_ms: 50,
                allowed_hashes: vec![],
                signing_public_key: None,
            })
            .expect("engine init"),
        );
        let conn = Connection::open_in_memory().expect("db init");
        let tenants = Arc::new(TenantStore::new(Arc::new(Mutex::new(conn))).expect("tenants init"));
        let consensus = Arc::new(crate::engine::consensus::ConsensusManager::new(
            ConsensusConfig::default(),
        ));
        ApiState {
            vault,
            engine,
            tenants,
            consensus,
        }
    }

    fn user_tenant() -> TenantContext {
        TenantContext {
            id: "user-test-1".to_string(),
            name: "Regular Tenant User".to_string(),
            namespace: "tenant-ns".to_string(),
            role: TenantRole::User,
        }
    }

    fn super_admin_tenant() -> TenantContext {
        TenantContext {
            id: "admin-1".to_string(),
            name: "Super Admin".to_string(),
            namespace: "global".to_string(),
            role: TenantRole::SuperAdmin,
        }
    }

    #[tokio::test]
    async fn test_policies_list_authorization() {
        let state = setup_test_state();
        // Regular non-admin tenant MUST be forbidden
        let res = policies_list(State(state.clone()), Extension(user_tenant())).await;
        assert_eq!(res.0["status"], "error");
        assert_eq!(res.0["error"], "Forbidden: SuperAdmin role required");

        // SuperAdmin MUST be authorized
        let res_admin = policies_list(State(state), Extension(super_admin_tenant())).await;
        assert_eq!(res_admin.0["status"], "ok");
    }

    #[tokio::test]
    async fn test_consensus_list_authorization() {
        let state = setup_test_state();
        // Regular non-admin tenant MUST be forbidden
        let res = consensus_list(State(state.clone()), Extension(user_tenant())).await;
        assert_eq!(res.0["status"], "error");
        assert_eq!(res.0["error"], "Forbidden: SuperAdmin role required");

        // SuperAdmin MUST be authorized
        let res_admin = consensus_list(State(state), Extension(super_admin_tenant())).await;
        assert_eq!(res_admin.0["status"], "ok");
    }

    #[tokio::test]
    async fn test_consensus_sign_authorization() {
        let state = setup_test_state();
        let payload = axum::Json(SignRequest {
            action_id: "act-456".to_string(),
            witness_name: None,
        });
        // Regular non-admin tenant MUST be forbidden from signing
        let res = consensus_sign(State(state), Extension(user_tenant()), payload).await;
        assert_eq!(res.0["status"], "error");
        assert_eq!(res.0["error"], "Forbidden: SuperAdmin role required");
    }

    #[tokio::test]
    async fn tenants_create_answers_with_http_status_codes() {
        let state = setup_test_state();
        let request = |namespace: &str, api_key: &str| {
            axum::Json(CreateTenantRequest {
                name: format!("org-{namespace}"),
                namespace: namespace.to_string(),
                api_key: api_key.to_string(),
            })
        };

        let (status, body) = tenants_create(
            State(state.clone()),
            Extension(user_tenant()),
            request("acme", "acme-key-for-tests"),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body.0["error"], "Forbidden: SuperAdmin role required");

        let (status, body) = tenants_create(
            State(state.clone()),
            Extension(super_admin_tenant()),
            request("acme", "acme-key-for-tests"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.0["status"], "ok");

        for (namespace, api_key) in [("global", "other-key"), ("other", "   "), ("acme", "k2")] {
            let (status, body) = tenants_create(
                State(state.clone()),
                Extension(super_admin_tenant()),
                request(namespace, api_key),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{namespace:?}");
            assert_eq!(body.0["status"], "error");
        }
    }

    #[tokio::test]
    async fn test_consensus_deny_authorization() {
        let state = setup_test_state();
        let payload = axum::Json(DenyRequest {
            action_id: "act-456".to_string(),
            reason: "malicious denial attempt".to_string(),
        });
        // Regular non-admin tenant MUST be forbidden from denying
        let res = consensus_deny(State(state), Extension(user_tenant()), payload).await;
        assert_eq!(res.0["status"], "error");
        assert_eq!(res.0["error"], "Forbidden: SuperAdmin role required");
    }
}

#[cfg(test)]
mod edge_case_tests {
    use super::*;
    use crate::audit::AuditEntry;
    use crate::config::ConsensusConfig;
    use crate::engine::consensus::ActionStatus;
    use crate::engine::ZnEngineConfig;
    use axum::extract::Query;
    use rusqlite::Connection;
    use std::collections::HashMap;
    use std::sync::Mutex;

    const FORBIDDEN: &str = "Forbidden: SuperAdmin role required";

    fn consensus_cfg(required: u32) -> ConsensusConfig {
        ConsensusConfig {
            enabled: true,
            critical_tools: vec!["delete_file".to_string()],
            required_signatures: required,
            ..Default::default()
        }
    }

    fn state_with(consensus: ConsensusConfig) -> ApiState {
        let vault = Arc::new(AuditVault::new(":memory:", None).expect("vault init"));
        let engine = Arc::new(
            ZnEngine::new(ZnEngineConfig {
                gas_limit: 10_000_000,
                memory_limit: 10 * 1024 * 1024,
                timeout_ms: 50,
                allowed_hashes: vec![],
                signing_public_key: None,
            })
            .expect("engine init"),
        );
        let conn = Connection::open_in_memory().expect("db init");
        let tenants = Arc::new(TenantStore::new(Arc::new(Mutex::new(conn))).expect("tenants init"));
        ApiState {
            vault,
            engine,
            tenants,
            consensus: Arc::new(crate::engine::consensus::ConsensusManager::new(consensus)),
        }
    }

    fn tenant(name: &str, namespace: &str, role: TenantRole) -> TenantContext {
        TenantContext {
            id: format!("id-{name}"),
            name: name.to_string(),
            namespace: namespace.to_string(),
            role,
        }
    }

    fn user() -> TenantContext {
        tenant("User A", "tenant-ns", TenantRole::User)
    }

    fn admin(name: &str) -> TenantContext {
        tenant(name, "global", TenantRole::SuperAdmin)
    }

    fn log_entry(state: &ApiState, namespace: &str, status: &str) {
        state
            .vault
            .log(AuditEntry::new("TOOL_CALL", "read_file", status).with_namespace(namespace))
            .expect("log entry");
    }

    fn query(pairs: &[(&str, &str)]) -> Query<HashMap<String, String>> {
        Query(
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        )
    }

    fn namespaces(body: &Value) -> Vec<String> {
        body["entries"]
            .as_array()
            .expect("entries array")
            .iter()
            .map(|e| e["namespace"].as_str().unwrap_or("").to_string())
            .collect()
    }

    #[tokio::test]
    async fn health_answers_ok() {
        assert_eq!(health().await, "OK");
    }

    #[tokio::test]
    async fn stats_with_an_empty_database_are_zero_for_every_role() {
        let state = state_with(ConsensusConfig::default());
        for ctx in [user(), admin("Root")] {
            let res = stats(State(state.clone()), Extension(ctx)).await;
            assert_eq!(res.0["status"], "ok");
            assert_eq!(res.0["stats"]["total"].as_u64(), Some(0));
            assert_eq!(res.0["stats"]["allowed"].as_u64(), Some(0));
            assert_eq!(res.0["stats"]["denied"].as_u64(), Some(0));
            // No traffic is reported as a full allow rate, never as NaN or a division error.
            assert_eq!(res.0["stats"]["allow_rate"].as_f64(), Some(100.0));
        }
    }

    #[tokio::test]
    async fn stats_count_only_the_callers_namespace() {
        let state = state_with(ConsensusConfig::default());
        log_entry(&state, "tenant-ns", "ALLOWED");
        log_entry(&state, "tenant-ns", "ALLOWED");
        log_entry(&state, "tenant-ns", "DENIED");
        for _ in 0..5 {
            log_entry(&state, "other-ns", "DENIED");
        }

        let own = stats(State(state.clone()), Extension(user())).await;
        assert_eq!(own.0["stats"]["total"].as_u64(), Some(3));
        assert_eq!(own.0["stats"]["allowed"].as_u64(), Some(2));
        assert_eq!(own.0["stats"]["denied"].as_u64(), Some(1));
        assert_eq!(own.0["stats"]["allow_rate"].as_f64(), Some(67.0));

        let stranger = tenant("Nobody", "empty-ns", TenantRole::Viewer);
        let none = stats(State(state.clone()), Extension(stranger)).await;
        assert_eq!(none.0["stats"]["total"].as_u64(), Some(0));

        let all = stats(State(state), Extension(admin("Root"))).await;
        assert_eq!(all.0["stats"]["total"].as_u64(), Some(8));
        assert_eq!(all.0["stats"]["denied"].as_u64(), Some(6));
    }

    #[tokio::test]
    async fn logs_never_return_another_tenants_entries() {
        let state = state_with(ConsensusConfig::default());
        log_entry(&state, "tenant-ns", "ALLOWED");
        log_entry(&state, "tenant-ns", "DENIED");
        log_entry(&state, "other-ns", "ALLOWED");
        log_entry(&state, "other-ns", "DENIED");
        log_entry(&state, "other-ns", "DENIED");

        // Query parameters that name another namespace or agent are ignored.
        for params in [
            query(&[]),
            query(&[("namespace", "other-ns")]),
            query(&[
                ("namespace", "other-ns"),
                ("agent_id", "x"),
                ("limit", "500"),
            ]),
            query(&[("limit", "not-a-number")]),
        ] {
            let res = logs(State(state.clone()), Extension(user()), params).await;
            assert_eq!(res.0["status"], "ok");
            assert_eq!(res.0["count"].as_u64(), Some(2));
            assert!(namespaces(&res.0).iter().all(|n| n == "tenant-ns"));
        }

        // A tenant with no entries sees none, not everybody's.
        let stranger = tenant("Nobody", "empty-ns", TenantRole::User);
        let res = logs(State(state.clone()), Extension(stranger), query(&[])).await;
        assert_eq!(res.0["count"].as_u64(), Some(0));

        // The platform admin sees every namespace.
        let res = logs(State(state), Extension(admin("Root")), query(&[])).await;
        assert_eq!(res.0["count"].as_u64(), Some(5));
    }

    #[tokio::test]
    async fn logs_limit_is_honoured_and_capped() {
        let state = state_with(ConsensusConfig::default());
        for _ in 0..505 {
            log_entry(&state, "tenant-ns", "ALLOWED");
        }
        let count = |res: &Json<Value>| res.0["count"].as_u64().unwrap();

        let res = logs(
            State(state.clone()),
            Extension(user()),
            query(&[("limit", "3")]),
        )
        .await;
        assert_eq!(count(&res), 3);
        let res = logs(
            State(state.clone()),
            Extension(user()),
            query(&[("limit", "0")]),
        )
        .await;
        assert_eq!(count(&res), 0);
        // Default page size.
        let res = logs(State(state.clone()), Extension(user()), query(&[])).await;
        assert_eq!(count(&res), 50);
        // A huge or negative limit never exceeds the cap or errors out.
        let res = logs(
            State(state.clone()),
            Extension(user()),
            query(&[("limit", "1000000")]),
        )
        .await;
        assert_eq!(count(&res), 500);
        let res = logs(State(state), Extension(user()), query(&[("limit", "-5")])).await;
        assert_eq!(res.0["status"], "ok");
        assert_eq!(count(&res), 50);
    }

    #[tokio::test]
    async fn tenants_list_requires_the_super_admin_role() {
        let state = state_with(ConsensusConfig::default());
        for role in [
            TenantRole::Admin,
            TenantRole::User,
            TenantRole::Viewer,
            TenantRole::Blocked,
        ] {
            let ctx = tenant("Caller", "tenant-ns", role);
            let res = tenants_list(State(state.clone()), Extension(ctx)).await;
            assert_eq!(res.0["status"], "error", "{role:?}");
            assert_eq!(res.0["error"], FORBIDDEN, "{role:?}");
            assert!(res.0.get("tenants").is_none(), "{role:?} saw the list");
        }
    }

    #[tokio::test]
    async fn tenants_list_shows_every_tenant_without_its_key() {
        let state = state_with(ConsensusConfig::default());
        let before = tenants_list(State(state.clone()), Extension(admin("Root")))
            .await
            .0["count"]
            .as_u64()
            .unwrap();
        state
            .tenants
            .create_tenant("Acme", "acme", "acme-secret-key-for-tests")
            .expect("create tenant");

        let res = tenants_list(State(state), Extension(admin("Root"))).await;
        assert_eq!(res.0["status"], "ok");
        assert_eq!(res.0["count"].as_u64(), Some(before + 1));
        let list = res.0["tenants"].as_array().expect("tenants array");
        assert!(list.iter().any(|t| t["namespace"] == "acme"));
        assert!(list.iter().all(|t| t["api_key"] == "[REDACTED]"));
        assert!(!res.0.to_string().contains("acme-secret-key-for-tests"));
    }

    #[tokio::test]
    async fn consensus_sign_with_an_unknown_id_changes_nothing() {
        let state = state_with(consensus_cfg(2));
        let id = state
            .consensus
            .propose_action("tenant-ns", "agent-1", "delete_file", "{}")
            .expect("critical tool is proposed");

        let payload = axum::Json(SignRequest {
            action_id: "no-such-action".to_string(),
            witness_name: None,
        });
        let res = consensus_sign(State(state.clone()), Extension(admin("Root")), payload).await;
        assert_eq!(res.0["status"], "error");
        assert_eq!(res.0["error"], "Action not found or already processed");
        assert!(res.0.get("action_status").is_none());

        let pending = state.consensus.list_pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, id);
        assert!(pending[0].signatures.is_empty());
        assert_eq!(state.consensus.get_status(&id), Some(ActionStatus::Pending));
        assert_eq!(state.consensus.get_status("no-such-action"), None);
    }

    #[tokio::test]
    async fn consensus_sign_by_a_non_admin_leaves_the_action_unsigned() {
        let state = state_with(consensus_cfg(1));
        let id = state
            .consensus
            .propose_action("tenant-ns", "agent-1", "delete_file", "{}")
            .unwrap();
        for role in [TenantRole::Admin, TenantRole::User, TenantRole::Viewer] {
            let payload = axum::Json(SignRequest {
                action_id: id.clone(),
                witness_name: Some("forged".to_string()),
            });
            let res = consensus_sign(
                State(state.clone()),
                Extension(tenant("Caller", "tenant-ns", role)),
                payload,
            )
            .await;
            assert_eq!(res.0["error"], FORBIDDEN, "{role:?}");
        }
        assert_eq!(state.consensus.get_status(&id), Some(ActionStatus::Pending));
        assert!(state.consensus.list_pending()[0].signatures.is_empty());
    }

    #[tokio::test]
    async fn consensus_sign_counts_each_admin_once_and_approves_at_the_threshold() {
        let state = state_with(consensus_cfg(2));
        let id = state
            .consensus
            .propose_action("tenant-ns", "agent-1", "delete_file", "{}")
            .unwrap();
        let sign = |who: &'static str| {
            let state = state.clone();
            let id = id.clone();
            async move {
                consensus_sign(
                    State(state),
                    Extension(admin(who)),
                    axum::Json(SignRequest {
                        action_id: id,
                        witness_name: None,
                    }),
                )
                .await
            }
        };

        let first = sign("Root A").await;
        assert_eq!(first.0["status"], "ok");
        assert_eq!(first.0["action_status"], "Pending");
        // The same admin signing again does not reach the threshold.
        let again = sign("Root A").await;
        assert_eq!(again.0["action_status"], "Pending");
        assert_eq!(state.consensus.list_pending()[0].signatures.len(), 1);
        // A second admin does.
        let second = sign("Root B").await;
        assert_eq!(second.0["action_status"], "Approved");
        // Once approved, further signatures are refused.
        let late = sign("Root C").await;
        assert_eq!(late.0["status"], "error");
        assert_eq!(
            state.consensus.get_status(&id),
            Some(ActionStatus::Approved)
        );
    }

    #[tokio::test]
    async fn consensus_deny_unknown_id_or_wrong_role_changes_nothing() {
        let state = state_with(consensus_cfg(2));
        let id = state
            .consensus
            .propose_action("tenant-ns", "agent-1", "delete_file", "{}")
            .unwrap();
        let deny = |ctx: TenantContext, action_id: String| {
            let state = state.clone();
            async move {
                consensus_deny(
                    State(state),
                    Extension(ctx),
                    axum::Json(DenyRequest {
                        action_id,
                        reason: "test".to_string(),
                    }),
                )
                .await
            }
        };

        let res = deny(admin("Root"), "no-such-action".to_string()).await;
        assert_eq!(res.0["status"], "error");
        assert_eq!(res.0["error"], "Action not found");

        let res = deny(user(), id.clone()).await;
        assert_eq!(res.0["error"], FORBIDDEN);
        assert_eq!(state.consensus.get_status(&id), Some(ActionStatus::Pending));

        // A real denial removes the action, and a second one finds nothing.
        let res = deny(admin("Root"), id.clone()).await;
        assert_eq!(res.0["status"], "ok");
        assert_eq!(state.consensus.get_status(&id), None);
        let res = deny(admin("Root"), id).await;
        assert_eq!(res.0["error"], "Action not found");
    }

    #[tokio::test]
    async fn consensus_deny_cannot_revoke_an_approved_action() {
        let state = state_with(consensus_cfg(1));
        let id = state
            .consensus
            .propose_action("tenant-ns", "agent-1", "delete_file", "{}")
            .unwrap();
        let signed = consensus_sign(
            State(state.clone()),
            Extension(admin("Root")),
            axum::Json(SignRequest {
                action_id: id.clone(),
                witness_name: None,
            }),
        )
        .await;
        assert_eq!(signed.0["action_status"], "Approved");

        let res = consensus_deny(
            State(state.clone()),
            Extension(admin("Root")),
            axum::Json(DenyRequest {
                action_id: id.clone(),
                reason: "too late".to_string(),
            }),
        )
        .await;
        assert_eq!(res.0["status"], "error");
        assert_eq!(res.0["error"], "Action not found or already processed");
        assert_eq!(
            state.consensus.get_status(&id),
            Some(ActionStatus::Approved)
        );
    }
}
