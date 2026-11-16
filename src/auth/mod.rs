//! Authentication module for zn Management API
//!
//! A token from `X-API-Key`, `Authorization: Bearer` or the `api_key` / `token`
//! query parameter is checked in this order:
//! 1. Legacy single API key (`ZN_API_KEY`): super-admin.
//! 2. Tenant API key, looked up in the TenantStore.
//! 3. JWT (HS256, signed with `ZN_JWT_SECRET`) carrying explicit claims:
//!    `roles` (lowercase `superadmin`, `admin`, `user`, `viewer` or `blocked`)
//!    and, for every role except `superadmin`, a tenant `namespace`.
//!
//! An invalid token gets 401; a valid JWT that grants no usable role gets 403.

use crate::config::normalize_credential;
use crate::tenants::{
    valid_tenant_namespace, TenantContext, TenantRole, TenantStore, GLOBAL_NAMESPACE,
};
use axum::{
    extract::Request,
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Authentication state shared across handlers
#[derive(Clone)]
pub struct AuthConfig {
    /// Legacy API key for super-admin (backwards compatibility)
    pub api_key: Option<String>,
    /// Secret for JWT validation (None = JWT disabled)
    pub jwt_secret: Option<String>,
    /// Tenant store for multi-tenancy
    pub tenant_store: Option<Arc<TenantStore>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: usize,
    pub iat: Option<usize>,
    /// Roles granted to the token: superadmin, admin, user or viewer.
    pub roles: Option<Vec<String>>,
    /// Tenant namespace; required for every role except superadmin.
    #[serde(default)]
    pub namespace: Option<String>,
}

/// Result of checking a bearer token as a JWT.
#[derive(Debug)]
enum JwtCheck {
    /// Bad signature, expired, or not a JWT at all.
    Invalid,
    /// Valid token that grants no usable role (carries the token's `sub`).
    NoRole(String),
    /// Valid token with an explicit role.
    Granted(TenantContext),
}

/// Strict role mapping for tokens: exact lowercase names only; anything else
/// grants nothing.
fn jwt_role(name: &str) -> Option<TenantRole> {
    match name {
        "superadmin" => Some(TenantRole::SuperAdmin),
        "admin" => Some(TenantRole::Admin),
        "user" => Some(TenantRole::User),
        "viewer" => Some(TenantRole::Viewer),
        "blocked" => Some(TenantRole::Blocked),
        _ => None,
    }
}

fn role_rank(role: TenantRole) -> u8 {
    match role {
        TenantRole::SuperAdmin => 4,
        TenantRole::Admin => 3,
        TenantRole::User => 2,
        TenantRole::Viewer => 1,
        TenantRole::Blocked => 0,
    }
}

/// Builds the request context from verified claims. Deny by default: the token
/// must name a known role, `blocked` wins over everything, the highest of the
/// remaining roles applies, and tenant roles need a valid tenant namespace.
fn context_from_claims(claims: &Claims) -> Option<TenantContext> {
    let roles: Vec<TenantRole> = claims
        .roles
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter_map(|r| jwt_role(r.as_str()))
        .collect();
    if roles.contains(&TenantRole::Blocked) {
        return None;
    }
    let role = roles.into_iter().max_by_key(|r| role_rank(*r))?;
    let namespace = match role {
        TenantRole::SuperAdmin => GLOBAL_NAMESPACE.to_string(),
        _ => claims
            .namespace
            .as_deref()
            .filter(|ns| valid_tenant_namespace(ns))?
            .to_string(),
    };
    Some(TenantContext {
        id: format!("jwt:{}", claims.sub),
        name: claims.sub.clone(),
        namespace,
        role,
    })
}

fn check_jwt(token: &str, secret: &str) -> JwtCheck {
    let decoding_key = DecodingKey::from_secret(secret.as_bytes());
    let mut validation = Validation::new(Algorithm::HS256);
    // A token is not valid before its `nbf` (not before) time, when present.
    validation.validate_nbf = true;
    match decode::<Claims>(token, &decoding_key, &validation) {
        Ok(data) => match context_from_claims(&data.claims) {
            Some(ctx) => JwtCheck::Granted(ctx),
            None => JwtCheck::NoRole(data.claims.sub),
        },
        Err(_) => JwtCheck::Invalid,
    }
}

impl AuthConfig {
    /// A blank API key or JWT secret counts as not configured. The API key is
    /// trimmed, as tokens from headers are; the JWT secret is used as given,
    /// since trimming it would change the signatures it verifies.
    pub fn new(api_key: Option<String>, jwt_secret: Option<String>) -> Self {
        Self {
            api_key: normalize_credential(api_key),
            jwt_secret: jwt_secret.filter(|s| !s.trim().is_empty()),
            tenant_store: None,
        }
    }

    pub fn with_tenant_store(mut self, store: Arc<TenantStore>) -> Self {
        self.tenant_store = Some(store);
        self
    }

    /// Check if authentication is required
    pub fn is_auth_required(&self) -> bool {
        self.api_key.is_some() || self.jwt_secret.is_some() || self.tenant_store.is_some()
    }
}

/// Super-admin context for legacy API key
pub fn super_admin_context() -> TenantContext {
    TenantContext {
        id: "super-admin".to_string(),
        name: "Super Admin".to_string(),
        namespace: GLOBAL_NAMESPACE.to_string(),
        role: TenantRole::SuperAdmin,
    }
}

/// A 401 with a JSON body that says what to send, so a person or a script that
/// gets it knows what to fix. `detail` names why the request was refused; it
/// never holds the key that was sent.
fn unauthorized_response(detail: &str) -> Response {
    let body = serde_json::json!({
        "error": "unauthorized",
        "message": format!(
            "{detail} Send your API key in the header \"Authorization: Bearer <your API key>\" (the header \"X-API-Key: <your API key>\" also works)."
        ),
        "expected_header": "Authorization: Bearer <your API key>",
    });
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Bearer")],
        axum::Json(body),
    )
        .into_response()
}

/// Authentication middleware supporting API Keys, JWTs, and Multi-Tenancy
pub async fn api_key_auth(mut request: Request, next: Next) -> Result<Response, StatusCode> {
    // Get auth config from request extensions
    let auth_config = request.extensions().get::<Arc<AuthConfig>>().cloned();

    let config = match auth_config {
        Some(c) => c,
        None => {
            // Fail closed: without its configuration the layer cannot decide.
            tracing::error!("Auth middleware is missing its AuthConfig extension");
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };

    // If no auth is configured, allow all
    if !config.is_auth_required() {
        return Ok(next.run(request).await);
    }

    // Extract authorization token
    let (auth_header, sent_in) = match request.headers().get("X-API-Key") {
        Some(v) => (v.to_str().ok(), "the X-API-Key header"),
        None => match request.headers().get(header::AUTHORIZATION) {
            Some(v) => (v.to_str().ok(), "the Authorization header"),
            None => (None, "the query string"),
        },
    };

    let token = match auth_header {
        Some(header_val) => Some(strip_bearer(header_val).to_string()),
        // Fallback: query parameters, only where a browser client cannot send headers (SSE and WebSocket):
        // a key in a query string ends up in proxy and access logs.
        None if query_token_allowed(request.uri().path()) => {
            request.uri().query().and_then(query_token)
        }
        None => None,
    };
    // An empty or blank token never authenticates.
    let token = token.filter(|t| !t.trim().is_empty());

    match token {
        Some(token) => {
            // 1. Check against Legacy Super-Admin API Key
            if let Some(expected_key) = config.api_key.as_deref().filter(|k| !k.trim().is_empty()) {
                if constant_time_compare(&token, expected_key) {
                    // Inject super-admin context
                    request.extensions_mut().insert(super_admin_context());
                    return Ok(next.run(request).await);
                }
            }

            // 2. Check against Tenant Store (Multi-Tenancy)
            if let Some(store) = &config.tenant_store {
                if let Ok(Some(tenant_ctx)) = store.find_by_api_key(&token) {
                    if tenant_ctx.role == TenantRole::Blocked {
                        tracing::warn!("Blocked tenant attempted access: {}", tenant_ctx.name);
                        return Err(StatusCode::FORBIDDEN);
                    }
                    // Inject tenant context into request
                    request.extensions_mut().insert(tenant_ctx);
                    return Ok(next.run(request).await);
                }
            }

            // 3. Try JWT validation: access comes only from explicit roles
            if let Some(secret) = &config.jwt_secret {
                match check_jwt(&token, secret) {
                    JwtCheck::Granted(ctx) => {
                        request.extensions_mut().insert(ctx);
                        return Ok(next.run(request).await);
                    }
                    JwtCheck::NoRole(sub) => {
                        tracing::warn!(sub = %sub, "JWT accepted but grants no usable role");
                        return Err(StatusCode::FORBIDDEN);
                    }
                    JwtCheck::Invalid => {}
                }
            }

            tracing::warn!(
                "Rejected request to {}: the API key sent in {} is not valid",
                request.uri().path(),
                sent_in
            );
            Ok(unauthorized_response(
                "The API key that was sent is not valid.",
            ))
        }
        None => {
            tracing::warn!(
                "Rejected request to {}: no API key was sent (expected the header Authorization: Bearer <key>, or X-API-Key; the key is ZN_API_KEY or the one saved in zn-superadmin-key.txt)",
                request.uri().path()
            );
            Ok(unauthorized_response("No API key was sent."))
        }
    }
}

/// Removes a `Bearer ` prefix in any letter case, and surrounding spaces.
fn strip_bearer(value: &str) -> &str {
    let value = value.trim();
    match value.get(..7) {
        Some(prefix) if prefix.eq_ignore_ascii_case("bearer ") => value[7..].trim(),
        _ => value,
    }
}

/// Routes that accept a key or token in the query string: the SSE events stream and the MCP WebSocket.
fn query_token_allowed(path: &str) -> bool {
    matches!(path, "/api/v1/events" | "/mcp/ws")
}

/// Value of the first `api_key` or `token` query parameter, percent-decoded.
/// A malformed value yields no token.
fn query_token(query: &str) -> Option<String> {
    query
        .split('&')
        .find_map(|pair| {
            let (key, val) = pair.split_once('=')?;
            (key == "api_key" || key == "token").then(|| percent_decode(val))
        })
        .flatten()
}

/// Decodes `%XX` escapes. `+` is kept as is: keys and tokens never contain
/// spaces, and base64 keys may contain `+`. Malformed escapes or invalid
/// UTF-8 yield None.
fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = value.get(i + 1..i + 3)?;
            if !hex.bytes().all(|c| c.is_ascii_hexdigit()) {
                return None;
            }
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Checks the optional MCP WebSocket token (`ZN_MCP_WS_TOKEN`), sent in the
/// `token` query parameter or the `X-MCP-Token` header. `None` means no token
/// is configured. Otherwise the provided token must match it exactly,
/// compared in constant time; a blank token, configured or provided, never
/// matches.
///
/// Known limit: the `token` query parameter is also read by the
/// authentication middleware as a credential, which takes the first of
/// `api_key` and `token`. A WebSocket client that sends both should put
/// `api_key` first, or send the MCP token in the `X-MCP-Token` header.
pub fn mcp_ws_token_matches(required: Option<&str>, provided: Option<&str>) -> bool {
    match required {
        None => true,
        Some(required) => provided.is_some_and(|provided| {
            !required.trim().is_empty()
                && !provided.trim().is_empty()
                && constant_time_compare(provided, required)
        }),
    }
}

/// Constant-time string comparison to prevent timing attacks
pub fn constant_time_compare(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }

    let mut result = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        result |= x ^ y;
    }
    result == 0
}

#[cfg(test)]
mod tests {
    #[test]
    fn query_credentials_only_for_sse_and_websocket() {
        assert!(query_token_allowed("/api/v1/events"));
        assert!(query_token_allowed("/mcp/ws"));
        assert!(!query_token_allowed("/api/v1/tenants"));
        assert!(!query_token_allowed("/api/v1/policies"));
        assert!(!query_token_allowed("/mcp/ws/extra"));
    }

    use super::*;

    use jsonwebtoken::{encode, EncodingKey, Header};
    use std::time::{SystemTime, UNIX_EPOCH};

    const SECRET: &str = "test-secret-for-unit-tests-only";

    fn now() -> usize {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_secs() as usize
    }

    fn claims(roles: Option<Vec<&str>>, namespace: Option<&str>, exp: usize) -> Claims {
        Claims {
            sub: "ops@example.com".to_string(),
            exp,
            iat: Some(now()),
            roles: roles.map(|r| r.into_iter().map(String::from).collect()),
            namespace: namespace.map(String::from),
        }
    }

    fn token_with(alg: Algorithm, claims: &Claims) -> String {
        encode(
            &Header::new(alg),
            claims,
            &EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .expect("encode test token")
    }

    fn token(roles: Option<Vec<&str>>, namespace: Option<&str>, exp: usize) -> String {
        token_with(Algorithm::HS256, &claims(roles, namespace, exp))
    }

    fn granted(check: JwtCheck) -> TenantContext {
        match check {
            JwtCheck::Granted(ctx) => ctx,
            other => panic!("expected access, got {:?}", other),
        }
    }

    #[test]
    fn test_constant_time_compare() {
        assert!(constant_time_compare("test", "test"));
        assert!(!constant_time_compare("test", "Test"));
    }

    #[test]
    fn jwt_without_roles_is_denied() {
        let t = token(None, Some("acme"), now() + 600);
        assert!(matches!(check_jwt(&t, SECRET), JwtCheck::NoRole(_)));
        let t = token(Some(vec![]), Some("acme"), now() + 600);
        assert!(matches!(check_jwt(&t, SECRET), JwtCheck::NoRole(_)));
    }

    #[test]
    fn jwt_with_unknown_role_is_denied() {
        let t = token(Some(vec!["root"]), Some("acme"), now() + 600);
        assert!(matches!(check_jwt(&t, SECRET), JwtCheck::NoRole(_)));
    }

    #[test]
    fn jwt_with_valid_tenant_role_is_scoped() {
        let ctx = granted(check_jwt(
            &token(Some(vec!["viewer"]), Some("acme"), now() + 600),
            SECRET,
        ));
        assert_eq!(ctx.role, TenantRole::Viewer);
        assert_eq!(ctx.namespace, "acme");
        assert!(!ctx.is_super_admin());
    }

    #[test]
    fn jwt_tenant_role_needs_a_namespace() {
        let t = token(Some(vec!["admin"]), None, now() + 600);
        assert!(matches!(check_jwt(&t, SECRET), JwtCheck::NoRole(_)));
        let t = token(Some(vec!["admin"]), Some("  "), now() + 600);
        assert!(matches!(check_jwt(&t, SECRET), JwtCheck::NoRole(_)));
    }

    #[test]
    fn jwt_superadmin_only_when_explicit() {
        let ctx = granted(check_jwt(
            &token(Some(vec!["superadmin"]), None, now() + 600),
            SECRET,
        ));
        assert!(ctx.is_super_admin());
        assert_eq!(ctx.namespace, "global");
    }

    #[test]
    fn jwt_highest_role_applies_and_blocked_wins() {
        let ctx = granted(check_jwt(
            &token(Some(vec!["viewer", "admin"]), Some("acme"), now() + 600),
            SECRET,
        ));
        assert_eq!(ctx.role, TenantRole::Admin);
        let t = token(
            Some(vec!["blocked", "superadmin"]),
            Some("acme"),
            now() + 600,
        );
        assert!(matches!(check_jwt(&t, SECRET), JwtCheck::NoRole(_)));
    }

    #[test]
    fn expired_or_foreign_jwt_is_invalid() {
        // Past the default 60 s leeway.
        let t = token(Some(vec!["superadmin"]), None, now() - 3600);
        assert!(matches!(check_jwt(&t, SECRET), JwtCheck::Invalid));
        let t = token(Some(vec!["superadmin"]), None, now() + 600);
        assert!(matches!(check_jwt(&t, "another-secret"), JwtCheck::Invalid));
        assert!(matches!(check_jwt("not-a-jwt", SECRET), JwtCheck::Invalid));
    }

    #[test]
    fn token_is_not_valid_before_nbf() {
        let raw = |nbf: usize| {
            encode(
                &Header::new(Algorithm::HS256),
                &serde_json::json!({
                    "sub": "ops@example.com",
                    "exp": now() + 7200,
                    "nbf": nbf,
                    "roles": ["superadmin"],
                }),
                &EncodingKey::from_secret(SECRET.as_bytes()),
            )
            .unwrap()
        };
        // Past the default 60 s leeway.
        assert!(matches!(
            check_jwt(&raw(now() + 3600), SECRET),
            JwtCheck::Invalid
        ));
        assert!(matches!(
            check_jwt(&raw(now() - 10), SECRET),
            JwtCheck::Granted(_)
        ));
        // Within the 60 s leeway.
        assert!(matches!(
            check_jwt(&raw(now() + 30), SECRET),
            JwtCheck::Granted(_)
        ));
    }

    #[test]
    fn only_hs256_is_accepted() {
        let c = claims(Some(vec!["superadmin"]), None, now() + 600);
        for alg in [Algorithm::HS384, Algorithm::HS512] {
            let t = token_with(alg, &c);
            assert!(
                matches!(check_jwt(&t, SECRET), JwtCheck::Invalid),
                "{alg:?}"
            );
        }

        // Unsigned token: {"alg":"none"} and an empty signature.
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&c).unwrap());
        for t in [
            format!("{header}.{payload}."),
            format!("{header}.{payload}"),
        ] {
            assert!(matches!(check_jwt(&t, SECRET), JwtCheck::Invalid));
        }
    }

    #[test]
    fn tenant_namespace_length_limit() {
        let ok = "a".repeat(128);
        let ctx = granted(check_jwt(
            &token(Some(vec!["viewer"]), Some(&ok), now() + 600),
            SECRET,
        ));
        assert_eq!(ctx.namespace, ok);
        let t = token(Some(vec!["viewer"]), Some(&"a".repeat(129)), now() + 600);
        assert!(matches!(check_jwt(&t, SECRET), JwtCheck::NoRole(_)));
    }

    #[test]
    fn bearer_prefix_and_query_values() {
        assert_eq!(strip_bearer("Bearer abc"), "abc");
        assert_eq!(strip_bearer("bearer abc"), "abc");
        assert_eq!(strip_bearer("BEARER   abc "), "abc");
        assert_eq!(strip_bearer("abc"), "abc");
        assert_eq!(strip_bearer("Bearer"), "Bearer");
        assert_eq!(
            query_token("a=1&token=x%2By%2Fz%3D"),
            Some("x+y/z=".to_string())
        );
        assert_eq!(query_token("api_key=a+b"), Some("a+b".to_string()));
        assert_eq!(query_token("token=%zz"), None);
        assert_eq!(query_token("token=%4"), None);
        assert_eq!(query_token("token=%ff"), None);
        assert_eq!(query_token("other=1"), None);
    }

    #[test]
    fn blank_key_and_secret_count_as_not_configured() {
        let c = AuthConfig::new(Some("   ".to_string()), Some(String::new()));
        assert!(c.api_key.is_none());
        assert!(c.jwt_secret.is_none());
        let c = AuthConfig::new(Some("\t\n ".to_string()), Some("  ".to_string()));
        assert!(c.api_key.is_none());
        assert!(c.jwt_secret.is_none());
    }

    #[test]
    fn api_key_is_trimmed_and_jwt_secret_is_kept() {
        let c = AuthConfig::new(Some("  key \n".to_string()), Some(" secret ".to_string()));
        assert_eq!(c.api_key.as_deref(), Some("key"));
        assert_eq!(c.jwt_secret.as_deref(), Some(" secret "));
    }

    #[test]
    fn mcp_ws_token_check() {
        // No token configured: no check.
        assert!(mcp_ws_token_matches(None, None));
        assert!(mcp_ws_token_matches(None, Some("anything")));
        // A configured token must be matched exactly.
        assert!(mcp_ws_token_matches(Some("ws-token"), Some("ws-token")));
        assert!(!mcp_ws_token_matches(Some("ws-token"), Some("ws-tokeN")));
        assert!(!mcp_ws_token_matches(Some("ws-token"), Some("ws-token ")));
        assert!(!mcp_ws_token_matches(Some("ws-token"), None));
        // Blank tokens never match, even each other.
        for blank in ["", " ", "\t"] {
            assert!(!mcp_ws_token_matches(Some(blank), Some(blank)), "{blank:?}");
            assert!(!mcp_ws_token_matches(Some("ws-token"), Some(blank)));
        }
        assert!(!mcp_ws_token_matches(Some(""), None));
    }

    #[test]
    fn blocked_alone_is_denied() {
        let t = token(Some(vec!["blocked"]), Some("acme"), now() + 600);
        assert!(matches!(check_jwt(&t, SECRET), JwtCheck::NoRole(_)));
    }

    #[test]
    fn role_names_are_exact_lowercase() {
        for role in ["SuperAdmin", "SUPERADMIN", "Admin", "super_admin", " admin"] {
            let t = token(Some(vec![role]), Some("acme"), now() + 600);
            assert!(
                matches!(check_jwt(&t, SECRET), JwtCheck::NoRole(_)),
                "{role:?}"
            );
        }
    }

    #[test]
    fn tenant_namespace_must_be_clean_and_not_global() {
        for ns in ["  acme  ", "ac me", "acme\n", "global", "GLOBAL", "Global"] {
            let t = token(Some(vec!["admin"]), Some(ns), now() + 600);
            assert!(
                matches!(check_jwt(&t, SECRET), JwtCheck::NoRole(_)),
                "{ns:?}"
            );
        }
        // A superadmin always gets the global namespace, whatever the claim says.
        let ctx = granted(check_jwt(
            &token(Some(vec!["superadmin"]), Some("acme"), now() + 600),
            SECRET,
        ));
        assert_eq!(ctx.namespace, GLOBAL_NAMESPACE);
    }

    // --- Middleware through a real router and HTTP server ---

    use axum::{routing::get, Extension, Router};
    use rusqlite::Connection;
    use std::sync::Mutex;

    const LEGACY_KEY: &str = "legacy-key-for-unit-tests-only";
    const TENANT_KEY: &str = "tenant-key-for-unit-tests-only";
    const BLOCKED_KEY: &str = "blocked-key-for-unit-tests-only";
    const ENCODED_KEY: &str = "enc+key/for=unit-tests-only";

    async fn whoami(Extension(t): Extension<TenantContext>) -> String {
        format!("{}:{}", t.role.as_str(), t.namespace)
    }

    /// The same server's SSE route, where a query-string credential is accepted.
    fn sse(url: &str) -> String {
        url.replace("/whoami", "/api/v1/events")
    }

    /// Serves `/whoami` behind the auth middleware with `config` (or without
    /// the AuthConfig extension when None) and returns its URL.
    async fn serve_config(config: Option<AuthConfig>) -> String {
        // `/api/v1/events` is one of the routes that accept a credential in the query string.
        let app = Router::new()
            .route("/whoami", get(whoami))
            .route("/api/v1/events", get(whoami))
            .layer(axum::middleware::from_fn(api_key_auth));
        let app = match config {
            Some(c) => app.layer(Extension(Arc::new(c))),
            None => app,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}/whoami")
    }

    /// Serves `/whoami` behind the auth middleware, configured like the
    /// management API, and returns its URL.
    async fn serve(jwt_as_tenant_key: &str) -> String {
        let conn = Arc::new(Mutex::new(Connection::open_in_memory().unwrap()));
        let store = Arc::new(TenantStore::new(Arc::clone(&conn)).unwrap());
        store.create_tenant("acme", "acme", TENANT_KEY).unwrap();
        store.create_tenant("blk", "blk", BLOCKED_KEY).unwrap();
        // The same strings as the legacy key and as a valid JWT, registered as
        // tenant keys, show which check runs first.
        store.create_tenant("dup", "dup", LEGACY_KEY).unwrap();
        store
            .create_tenant("jwtkey", "jwtkey", jwt_as_tenant_key)
            .unwrap();
        store.create_tenant("enc", "enc", ENCODED_KEY).unwrap();
        conn.lock()
            .unwrap()
            .execute(
                "UPDATE tenants SET role = 'blocked' WHERE namespace = 'blk'",
                [],
            )
            .unwrap();

        serve_config(Some(
            AuthConfig::new(Some(LEGACY_KEY.to_string()), Some(SECRET.to_string()))
                .with_tenant_store(store),
        ))
        .await
    }

    async fn call(url: &str, header: Option<(&str, String)>) -> (u16, String) {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let mut req = client.get(url);
        if let Some((name, value)) = header {
            req = req.header(name, value);
        }
        let resp = req.send().await.unwrap();
        let status = resp.status().as_u16();
        (status, resp.text().await.unwrap())
    }

    fn bearer(t: &str) -> Option<(&'static str, String)> {
        Some(("Authorization", format!("Bearer {t}")))
    }

    #[tokio::test]
    async fn middleware_status_codes_and_check_order() {
        let superadmin_jwt = token(Some(vec!["superadmin"]), None, now() + 600);
        let url = serve(&superadmin_jwt).await;

        // 401: nothing, garbage, expired or foreign tokens.
        assert_eq!(call(&url, None).await.0, 401);
        assert_eq!(call(&url, bearer("not-a-key")).await.0, 401);
        let expired = token(Some(vec!["viewer"]), Some("acme"), now() - 3600);
        assert_eq!(call(&url, bearer(&expired)).await.0, 401);
        let hs512 = token_with(
            Algorithm::HS512,
            &claims(Some(vec!["superadmin"]), None, now() + 600),
        );
        assert_eq!(call(&url, bearer(&hs512)).await.0, 401);

        // 403: blocked tenant, valid JWT without a usable role.
        assert_eq!(call(&url, bearer(BLOCKED_KEY)).await.0, 403);
        let no_role = token(None, Some("acme"), now() + 600);
        assert_eq!(call(&url, bearer(&no_role)).await.0, 403);
        let global_ns = token(Some(vec!["admin"]), Some("global"), now() + 600);
        assert_eq!(call(&url, bearer(&global_ns)).await.0, 403);

        // 200 with the expected context, from a header or the query string.
        assert_eq!(
            call(&url, bearer(TENANT_KEY)).await,
            (200, "user:acme".to_string())
        );
        assert_eq!(
            call(&url, Some(("X-API-Key", TENANT_KEY.to_string()))).await,
            (200, "user:acme".to_string())
        );
        // A credential in the query string counts only on the SSE and WebSocket routes.
        assert_eq!(
            call(&format!("{url}?token={TENANT_KEY}"), None).await.0,
            401
        );
        assert_eq!(
            call(&format!("{}?token={TENANT_KEY}", sse(&url)), None).await,
            (200, "user:acme".to_string())
        );
        let viewer = token(Some(vec!["viewer"]), Some("acme"), now() + 600);
        assert_eq!(
            call(&url, bearer(&viewer)).await,
            (200, "viewer:acme".to_string())
        );

        // Order: legacy key, then tenant keys, then JWT.
        assert_eq!(
            call(&url, bearer(LEGACY_KEY)).await,
            (200, "superadmin:global".to_string())
        );
        assert_eq!(
            call(&url, bearer(&superadmin_jwt)).await,
            (200, "user:jwtkey".to_string())
        );
    }

    #[tokio::test]
    async fn empty_tokens_never_authenticate() {
        // An empty legacy key set directly on the config, as a caller that
        // bypasses AuthConfig::new could do.
        let config = AuthConfig {
            api_key: Some(String::new()),
            jwt_secret: None,
            tenant_store: None,
        };
        let url = serve_config(Some(config)).await;
        assert_eq!(call(&url, Some(("X-API-Key", String::new()))).await.0, 401);
        assert_eq!(call(&url, bearer("")).await.0, 401);
        assert_eq!(call(&format!("{}?api_key=", sse(&url)), None).await.0, 401);
        assert_eq!(call(&format!("{}?token=", sse(&url)), None).await.0, 401);

        // The same with a blank legacy key and blank tokens: a query value can
        // carry spaces once percent-decoded.
        let config = AuthConfig {
            api_key: Some("   ".to_string()),
            jwt_secret: None,
            tenant_store: None,
        };
        let url = serve_config(Some(config)).await;
        assert_eq!(
            call(&format!("{}?api_key=%20%20%20", sse(&url)), None)
                .await
                .0,
            401
        );
        assert_eq!(call(&format!("{}?token=%09", sse(&url)), None).await.0, 401);
        assert_eq!(call(&url, bearer("   ")).await.0, 401);
    }

    #[tokio::test]
    async fn bearer_case_and_encoded_query_are_accepted() {
        let url = serve(&token(Some(vec!["superadmin"]), None, now() + 600)).await;
        for prefix in ["bearer", "BEARER"] {
            assert_eq!(
                call(
                    &url,
                    Some(("Authorization", format!("{prefix} {TENANT_KEY}")))
                )
                .await,
                (200, "user:acme".to_string())
            );
        }
        assert_eq!(
            call(
                &format!("{}?api_key=enc%2Bkey%2Ffor%3Dunit-tests-only", sse(&url)),
                None
            )
            .await,
            (200, "user:enc".to_string())
        );
        assert_eq!(
            call(&format!("{}?api_key=%zz", sse(&url)), None).await.0,
            401
        );
    }

    #[tokio::test]
    async fn missing_auth_config_fails_closed() {
        let url = serve_config(None).await;
        assert_eq!(call(&url, bearer(LEGACY_KEY)).await.0, 500);
        assert_eq!(call(&url, None).await.0, 500);
    }
}

#[cfg(test)]
mod unauthorized_body_tests {
    use super::*;
    use axum::{routing::get, Extension, Router};

    async fn serve() -> String {
        let app = Router::new()
            .route("/ping", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn(api_key_auth))
            .layer(Extension(Arc::new(AuthConfig::new(
                Some("right-key-for-tests".to_string()),
                None,
            ))));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}/ping")
    }

    async fn rejected(req: reqwest::RequestBuilder) -> serde_json::Value {
        let resp = req.send().await.unwrap();
        assert_eq!(resp.status().as_u16(), 401);
        assert_eq!(
            resp.headers()
                .get("www-authenticate")
                .map(|v| v.to_str().unwrap()),
            Some("Bearer")
        );
        resp.json().await.expect("the 401 body is JSON")
    }

    #[tokio::test]
    async fn a_missing_key_gets_a_json_body_naming_the_header() {
        let url = serve().await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let body = rejected(client.get(&url)).await;
        assert_eq!(body["error"], "unauthorized");
        assert_eq!(
            body["expected_header"],
            "Authorization: Bearer <your API key>"
        );
        assert!(body["message"]
            .as_str()
            .unwrap()
            .contains("No API key was sent"));
        let text = body.to_string();
        assert!(!text.contains("zn-superadmin-key"));
        assert!(!text.contains("ZN_API_KEY"));
    }

    #[tokio::test]
    async fn a_wrong_key_gets_the_same_hint_and_is_never_echoed() {
        let url = serve().await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let body = rejected(
            client
                .get(&url)
                .header("Authorization", "Bearer wrong-secret-value"),
        )
        .await;
        let text = body.to_string();
        assert!(text.contains("not valid"));
        assert!(text.contains("Authorization: Bearer"));
        assert!(!text.contains("wrong-secret-value"));
        assert!(!text.contains("zn-superadmin-key"));
        assert!(!text.contains("ZN_API_KEY"));
    }
}
