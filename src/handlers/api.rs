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

    #[tokio::test]
    async fn health_answers_ok() {
        assert_eq!(health().await, "OK");
    }

    #[tokio::test]
    async fn tenants_list_needs_super_admin() {
        let state = setup_test_state();
        let res = tenants_list(State(state.clone()), Extension(user_tenant())).await;
        assert_eq!(res.0["status"], "error");
        assert_eq!(res.0["error"], "Forbidden: SuperAdmin role required");
        assert!(
            res.0.get("tenants").is_none(),
            "a regular tenant sees no list"
        );

        let (status, _) = tenants_create(
            State(state.clone()),
            Extension(super_admin_tenant()),
            axum::Json(CreateTenantRequest {
                name: "org-acme".to_string(),
                namespace: "acme".to_string(),
                api_key: "acme-key-for-tests".to_string(),
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let res = tenants_list(State(state), Extension(super_admin_tenant())).await;
        assert_eq!(res.0["status"], "ok");
        let listed = res.0["tenants"].to_string();
        assert!(listed.contains("acme"), "{listed}");
    }

    #[tokio::test]
    async fn logs_show_a_regular_tenant_only_its_namespace() {
        let state = setup_test_state();
        for (ns, tool) in [("tenant-ns", "mine_tool"), ("other-ns", "other_tool")] {
            let mut e = crate::audit::AuditEntry::new("TOOL_CALL", tool, "ALLOWED");
            e.namespace = Some(ns.to_string());
            state.vault.log(e).expect("log");
        }
        let q = |l: &str| {
            axum::extract::Query(
                [("limit".to_string(), l.to_string())]
                    .into_iter()
                    .collect::<std::collections::HashMap<_, _>>(),
            )
        };
        let body = logs(State(state.clone()), Extension(user_tenant()), q("50"))
            .await
            .0
            .to_string();
        assert!(body.contains("mine_tool"), "{body}");
        assert!(
            !body.contains("other_tool"),
            "another namespace leaked: {body}"
        );
        let body = logs(
            State(state.clone()),
            Extension(super_admin_tenant()),
            q("50"),
        )
        .await
        .0
        .to_string();
        assert!(
            body.contains("mine_tool") && body.contains("other_tool"),
            "{body}"
        );
        // A limit that is not a number falls back to the default; a huge one is capped.
        let body = logs(
            State(state.clone()),
            Extension(user_tenant()),
            q("not-a-number"),
        )
        .await
        .0
        .to_string();
        assert!(body.contains("mine_tool"), "{body}");
        let body = logs(State(state), Extension(user_tenant()), q("100000000"))
            .await
            .0
            .to_string();
        assert!(body.contains("mine_tool"), "{body}");
    }
}
