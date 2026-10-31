//! Configuration module for zn Security Proxy
//!
//! Provides unified configuration management from files, environment variables,
//! and CLI arguments with sensible defaults.

use crate::webhooks::WebhookConfig;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Shortest accepted `ZN_JWT_SECRET`: HS256 keys should have at least 256 bits.
pub const MIN_JWT_SECRET_BYTES: usize = 32;

/// Main configuration structure for zn
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZnConfig {
    /// Environment (development, production)
    #[serde(default = "default_environment")]
    pub environment: String,

    /// Server configuration
    #[serde(default)]
    pub server: ServerConfig,

    /// Security configuration
    #[serde(default)]
    pub security: SecurityConfig,

    /// Engine configuration
    #[serde(default)]
    pub engine: EngineConfig,

    /// Audit configuration
    #[serde(default)]
    pub audit: AuditConfig,

    /// Webhook configurations for alerts
    #[serde(default)]
    pub webhooks: Vec<WebhookConfig>,

    /// SIEM (Audit Export) configuration
    #[serde(default)]
    pub siem: SiemConfig,

    /// KMS (Key Management Service) configuration
    #[serde(default)]
    pub kms: KmsConfig,

    /// Neural configuration
    #[serde(default)]
    pub neural: NeuralConfig,

    /// Fusion Gate: rules ∥ neural head. Missing section = disabled.
    #[serde(default)]
    pub fusion: FusionConfig,

    /// Managed Rulesets (Cloudflare Style)
    #[serde(default)]
    pub managed_rules: ManagedRulesConfig,

    /// Recursive Loop Breaker
    #[serde(default)]
    pub loop_breaker: LoopBreakerConfig,

    /// Semantic Context Caching
    #[serde(default)]
    pub caching: CachingConfig,

    /// M-of-N Consensus Authorization
    #[serde(default)]
    pub consensus: ConsensusConfig,

    /// Guardrails configuration for paranoid modes
    #[serde(default)]
    pub guardrails: GuardrailsConfig,
}

impl Default for ZnConfig {
    fn default() -> Self {
        Self {
            environment: default_environment(),
            server: ServerConfig::default(),
            security: SecurityConfig::default(),
            engine: EngineConfig::default(),
            audit: AuditConfig::default(),
            webhooks: vec![],
            siem: SiemConfig::default(),
            kms: KmsConfig::default(),
            neural: NeuralConfig::default(),
            fusion: FusionConfig::default(),
            managed_rules: ManagedRulesConfig::default(),
            loop_breaker: LoopBreakerConfig::default(),
            caching: CachingConfig::default(),
            consensus: ConsensusConfig::default(),
            guardrails: GuardrailsConfig::default(),
        }
    }
}

fn default_environment() -> String {
    "development".to_string()
}

/// Server-related configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    /// Management API port
    #[serde(default = "default_port")]
    pub port: u16,

    /// Bind address
    #[serde(default = "default_bind_address")]
    pub bind_address: String,

    /// Broadcast channel capacity
    #[serde(default = "default_channel_capacity")]
    pub channel_capacity: usize,

    /// Largest WebSocket message the gateway accepts, in bytes (default 1 MiB).
    /// A larger message closes the connection.
    #[serde(default = "default_ws_max_message_bytes")]
    pub ws_max_message_bytes: usize,

    /// Largest single WebSocket frame the gateway accepts, in bytes (default 1 MiB).
    /// A larger frame closes the connection.
    #[serde(default = "default_ws_max_frame_bytes")]
    pub ws_max_frame_bytes: usize,

    /// Seconds a management API connection may go without receiving a byte before it is closed
    /// (default 900, 15 minutes; 0 means the default). It ends an SSE stream or WebSocket session
    /// that nobody uses.
    #[serde(default = "default_session_idle_timeout_secs")]
    pub session_idle_timeout_secs: u64,

    /// Seconds a write to a management API client may stay blocked (a client that does not read)
    /// before the connection is closed (default 30; 0 means the default).
    #[serde(default = "default_write_timeout_secs")]
    pub write_timeout_secs: u64,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            port: default_port(),
            bind_address: default_bind_address(),
            channel_capacity: default_channel_capacity(),
            ws_max_message_bytes: default_ws_max_message_bytes(),
            ws_max_frame_bytes: default_ws_max_frame_bytes(),
            session_idle_timeout_secs: default_session_idle_timeout_secs(),
            write_timeout_secs: default_write_timeout_secs(),
        }
    }
}

fn default_port() -> u16 {
    9090
}
fn default_ws_max_message_bytes() -> usize {
    1024 * 1024
}
fn default_ws_max_frame_bytes() -> usize {
    1024 * 1024
}
fn default_session_idle_timeout_secs() -> u64 {
    900
}
fn default_write_timeout_secs() -> u64 {
    30
}
fn default_bind_address() -> String {
    "127.0.0.1".to_string()
}
fn default_channel_capacity() -> usize {
    100
}

/// Security-related configuration
#[derive(Clone, Serialize, Deserialize)]
pub struct SecurityConfig {
    /// API key for authentication (if None, auth is disabled - NOT recommended for production)
    pub api_key: Option<String>,

    /// Allowed CORS origins (if empty, only localhost is allowed)
    #[serde(default)]
    pub allowed_origins: Vec<String>,

    /// Enable rate limiting
    #[serde(default = "default_true")]
    pub rate_limit_enabled: bool,

    /// Maximum requests per minute per client
    #[serde(default = "default_rate_limit")]
    pub rate_limit_per_minute: u32,

    /// Multi-tenant namespace
    pub namespace: Option<String>,

    /// Secret for JWT validation
    pub jwt_secret: Option<String>,

    /// Token for MCP WebSocket authentication
    pub mcp_ws_token: Option<String>,
}

/// Debug output hides the API key, the JWT secret and the MCP WebSocket
/// token, so a `{:?}` of the configuration never leaks them.
impl std::fmt::Debug for SecurityConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let hide = |v: &Option<String>| v.as_ref().map(|_| "<redacted>");
        f.debug_struct("SecurityConfig")
            .field("api_key", &hide(&self.api_key))
            .field("allowed_origins", &self.allowed_origins)
            .field("rate_limit_enabled", &self.rate_limit_enabled)
            .field("rate_limit_per_minute", &self.rate_limit_per_minute)
            .field("namespace", &self.namespace)
            .field("jwt_secret", &hide(&self.jwt_secret))
            .field("mcp_ws_token", &hide(&self.mcp_ws_token))
            .finish()
    }
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            api_key: normalize_credential(std::env::var("ZN_API_KEY").ok()),
            allowed_origins: vec![
                "http://localhost:5173".to_string(),
                "http://localhost:9090".to_string(),
                "http://127.0.0.1:5173".to_string(),
                "http://127.0.0.1:9090".to_string(),
            ],
            rate_limit_enabled: true,
            rate_limit_per_minute: default_rate_limit(),
            namespace: std::env::var("ZN_NAMESPACE").ok(),
            jwt_secret: std::env::var("ZN_JWT_SECRET").ok(),
            mcp_ws_token: normalize_credential(std::env::var("ZN_MCP_WS_TOKEN").ok()),
        }
    }
}

/// Trims a key or token and treats a blank one as not set. Used for
/// `ZN_API_KEY` and `ZN_MCP_WS_TOKEN` (and their config file values), so
/// `ZN_API_KEY=` from an unset compose variable never matches an empty token
/// and a key pasted with a trailing newline still works.
pub fn normalize_credential(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// The value a credential takes after the environment overrides: the
/// environment variable when it is set (even to a blank value, which unsets
/// it), otherwise the current value, then normalized.
fn credential_override(current: Option<String>, env_value: Option<String>) -> Option<String> {
    normalize_credential(env_value.or(current))
}

fn default_true() -> bool {
    true
}
fn default_rate_limit() -> u32 {
    60
}

/// WASM engine configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineConfig {
    /// Gas limit for WASM policy execution
    #[serde(default = "default_gas_limit")]
    pub gas_limit: u64,

    /// Max memory for WASM (MB)
    #[serde(default = "default_memory_limit")]
    pub memory_limit_mb: u64,

    /// Execution timeout (ms)
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,

    /// Allowed policy SHA-256 hashes (hex)
    #[serde(default)]
    pub allowed_policy_hashes: Vec<String>,

    /// Public key for Ed25519 signature verification (hex)
    pub signing_public_key: Option<String>,

    /// Policy directory path
    #[serde(default = "default_policy_dir")]
    pub policy_dir: String,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            gas_limit: default_gas_limit(),
            memory_limit_mb: default_memory_limit(),
            timeout_ms: default_timeout(),
            allowed_policy_hashes: vec![],
            signing_public_key: None,
            policy_dir: default_policy_dir(),
        }
    }
}

fn default_gas_limit() -> u64 {
    10_000_000
}
fn default_memory_limit() -> u64 {
    128
} // 128 MB
fn default_timeout() -> u64 {
    1000
} // 1 second
fn default_policy_dir() -> String {
    "./policies_bin".to_string()
}

/// Audit configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditConfig {
    /// Database file path
    #[serde(default = "default_db_path")]
    pub db_path: String,

    /// Maximum logs to keep in memory for dashboard
    #[serde(default = "default_max_logs")]
    pub max_logs_in_memory: usize,

    /// Enable database encryption (requires encryption key)
    #[serde(default)]
    pub encryption_enabled: bool,

    /// Database encryption key
    pub encryption_key: Option<String>,

    /// Persist the (scrubbed) request payload of each audited call.
    /// Off by default: the audit log keeps only metadata (event, time, tool,
    /// status, policy, agent, namespace). Turning it on requires an
    /// encryption key (`ZN_DB_KEY`), in every environment.
    #[serde(default)]
    pub store_payloads: bool,

    /// Fail closed when the audit record of a call cannot be written: the
    /// call is denied with a JSON-RPC error. Off by default: a write failure
    /// is logged and counted (`zn_audit_write_failures_total`) and the call
    /// goes on.
    #[serde(default)]
    pub require_write: bool,
}

impl Default for AuditConfig {
    fn default() -> Self {
        Self {
            db_path: default_db_path(),
            max_logs_in_memory: default_max_logs(),
            encryption_enabled: false,
            encryption_key: std::env::var("ZN_DB_KEY").ok(),
            store_payloads: false,
            require_write: false,
        }
    }
}

fn default_db_path() -> String {
    "zn.db".to_string()
}
fn default_max_logs() -> usize {
    50
}

/// SIEM (External Audit Export) configuration
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SiemConfig {
    /// External SIEM endpoint (HTTP/HTTPS)
    pub endpoint: Option<String>,
    /// Authentication token for SIEM
    pub token: Option<String>,
    /// Export batch size
    #[serde(default = "default_batch_size")]
    pub batch_size: usize,
}

fn default_batch_size() -> usize {
    10
}

/// KMS Configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KmsConfig {
    /// Type of KMS to use (local, aws, gcp, vaults)
    #[serde(default = "default_kms_type")]
    pub kms_type: String,
    /// Key ID / ARN
    pub key_id: Option<String>,
    /// Region (if applicable)
    pub region: Option<String>,
    /// When `key_id` is set and the key cannot be fetched from the KMS, start
    /// anyway with the key from the config. Off by default: the gateway
    /// refuses to start instead.
    #[serde(default)]
    pub allow_config_fallback: bool,
}

impl Default for KmsConfig {
    fn default() -> Self {
        Self {
            kms_type: default_kms_type(),
            key_id: std::env::var("ZN_KMS_KEY_ID").ok(),
            region: std::env::var("ZN_KMS_REGION").ok(),
            allow_config_fallback: false,
        }
    }
}

fn default_kms_type() -> String {
    "local".to_string()
}

/// Neural / AI Security configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NeuralConfig {
    /// Enable neural analysis
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Anomaly score threshold for blocking (0.0 - 5.0+)
    /// Typical L2 distance for all-MiniLM is < 1.0 for similar.
    #[serde(default = "default_neural_threshold")]
    pub threshold: f32,

    /// If true, block requests that exceed threshold
    #[serde(default = "default_false")]
    pub active_blocking: bool,

    /// Classifier probability threshold (0.0 - 1.0) for the fused decision.
    /// Only used when the model ships a `head.json`; anomaly-only models ignore it.
    #[serde(default = "default_classifier_threshold")]
    pub classifier_threshold: f32,

    /// Embedding model ID to use
    #[serde(default = "default_neural_model")]
    pub model_id: String,

    /// Local cache directory for the model files (~/ expanded; ZN_NEURAL_MODEL_PATH overrides)
    #[serde(default = "default_neural_model_path")]
    pub model_path: String,

    /// Embedding dimension (must match the model, e.g. 384 for all-MiniLM-L6-v2)
    #[serde(default = "default_neural_dim")]
    pub dim: usize,
}

impl Default for NeuralConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            threshold: default_neural_threshold(),
            active_blocking: false, // Default to Shadow Mode (false)
            classifier_threshold: default_classifier_threshold(),
            model_id: default_neural_model(),
            model_path: default_neural_model_path(),
            dim: default_neural_dim(),
        }
    }
}

fn default_neural_threshold() -> f32 {
    1.2
}
fn default_classifier_threshold() -> f32 {
    0.5
}
fn default_neural_model() -> String {
    "all-MiniLM-L6-v2".to_string()
}
fn default_neural_model_path() -> String {
    "~/.zn/models/all-MiniLM-L6-v2".to_string()
}
fn default_neural_dim() -> usize {
    384
}
fn default_false() -> bool {
    false
}

/// Fusion Gate: block iff rules hit OR neural score >= tau.
///
/// A missing `[fusion]` section deserializes to `enabled: false`, which must
/// degrade EXACTLY to the rules-only gate (regression-guarded in evals).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FusionConfig {
    /// Fusion off by default; opt-in via config.
    #[serde(default)]
    pub enabled: bool,

    /// Neural camera threshold on the head probability in [0, 1]. Shipped
    /// default is the offline value maximizing fused recall subject to fused
    /// FPR <= 0.014 over the exported fixture (see README "Gate" section).
    #[serde(default = "default_fusion_tau")]
    pub tau: f32,

    /// Model dir holding `model_int8.onnx` (or `model.onnx`) + `tokenizer.json`
    /// + `head.json` (~/ expanded).
    #[serde(default = "default_fusion_model_path")]
    pub model_path: String,

    /// Model version id; must match the exported score fixture's `model_id`.
    #[serde(default = "default_fusion_model_id")]
    pub model_id: String,
}

impl Default for FusionConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            tau: default_fusion_tau(),
            model_path: default_fusion_model_path(),
            model_id: default_fusion_model_id(),
        }
    }
}

fn default_fusion_tau() -> f32 {
    // Offline sweep over evals/fixtures/head_scores.json (ml/eval.py
    // --export-scores): lowest tau maximizing fused recall subject to fused
    // FPR <= 1.4%. Alternatives in README "Gate" section.
    0.623
}
fn default_fusion_model_path() -> String {
    "~/.zn/models/zn-minilm-l6-v2-sec-1787474325".to_string()
}
fn default_fusion_model_id() -> String {
    // Gate-valid run with a candle-evaluable export; the newest dir
    // (1787490939) is a 100-vector smoke run whose re-export candle-onnx
    // 0.9.2 cannot evaluate (see README "Gate" section).
    "zn-minilm-l6-v2-sec-1787474325".to_string()
}

/// Managed Rulesets Configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedRulesConfig {
    /// Enable PII (Personally Identifiable Information) Redaction
    #[serde(default = "default_true")]
    pub pii_redaction: bool,
    /// Enable LFI (Local File Inclusion) Protection
    #[serde(default = "default_true")]
    pub lfi_protection: bool,
    /// Enable SQL Injection Protection
    #[serde(default = "default_true")]
    pub sql_injection: bool,
    /// Enable Prompt Injection Protection
    #[serde(default = "default_true")]
    pub prompt_injection: bool,
    /// Block common dangerous system commands (rm, format, etc)
    #[serde(default = "default_true")]
    pub restricted_commands: bool,
    /// Multimodal: OCR and Visual PII Redaction
    #[serde(default = "default_false")]
    pub visual_pii_redaction: bool,
}

impl Default for ManagedRulesConfig {
    fn default() -> Self {
        Self {
            pii_redaction: true,
            lfi_protection: true,
            sql_injection: true,
            prompt_injection: true,
            restricted_commands: true,
            visual_pii_redaction: false,
        }
    }
}

/// Loop Breaker Configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopBreakerConfig {
    /// Enable detection of infinite tool loops
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Maximum number of times the same tool/args can be called
    #[serde(default = "default_max_repeats")]
    pub max_repeats: usize,
    /// Time window for repeat detection (seconds)
    #[serde(default = "default_window")]
    pub window_seconds: u64,
}

impl Default for LoopBreakerConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_repeats: 3,
            window_seconds: 60,
        }
    }
}

fn default_max_repeats() -> usize {
    3
}
fn default_window() -> u64 {
    60
}

/// Caching Configuration
/// Longest `caching.ttl_seconds` the configuration accepts: one year.
pub const MAX_CACHE_TTL_SECONDS: u64 = 365 * 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachingConfig {
    /// Enable tool result caching
    #[serde(default = "default_false")]
    pub enabled: bool,
    /// Cache Time-To-Live (seconds), from 0 to `MAX_CACHE_TTL_SECONDS` (one year)
    #[serde(default = "default_ttl")]
    pub ttl_seconds: u64,
}

impl Default for CachingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            ttl_seconds: 300, // 5 minutes
        }
    }
}

fn default_ttl() -> u64 {
    300
}

/// Consensus Authorization Configuration (M-of-N)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsensusConfig {
    /// Enable multi-sig consensus for critical tools
    #[serde(default = "default_false")]
    pub enabled: bool,
    /// List of tool patterns that require consensus (e.g., "admin:*", "delete_file")
    #[serde(default)]
    pub critical_tools: Vec<String>,
    /// Number of required signatures (M)
    #[serde(default = "default_m")]
    pub required_signatures: u32,
    /// Allow neural core to act as one witness if risk is low
    #[serde(default = "default_true")]
    pub neural_as_witness: bool,
    /// Seconds a proposed action stays valid (default 900). After that it can no
    /// longer be approved and is removed. 0 means the default.
    #[serde(default = "default_pending_ttl_secs")]
    pub pending_ttl_secs: u64,
}

impl Default for ConsensusConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            critical_tools: Vec::new(),
            required_signatures: 2,
            neural_as_witness: true,
            pending_ttl_secs: default_pending_ttl_secs(),
        }
    }
}

fn default_pending_ttl_secs() -> u64 {
    900
}

fn default_m() -> u32 {
    2
}

/// Guardrails configuration for paranoid modes
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuardrailsConfig {
    /// Default mode: alert-only (no blocking) for neural anomalies
    #[serde(default = "default_true")]
    pub alert_only: bool,
    /// Paranoia level (1-5) controls thresholds and rollback aggressiveness
    #[serde(default = "default_paranoia_level")]
    pub paranoia_level: u8,
    /// Minimum samples before FPR guard evaluates rollback
    #[serde(default = "default_min_samples")]
    pub min_samples: u64,
    /// FPR margin (control + margin triggers rollback)
    #[serde(default = "default_fpr_margin")]
    pub fpr_margin: f64,
    /// Enable nearest-neighbor audit logging
    #[serde(default = "default_true")]
    pub nearest_neighbor_audit: bool,
}

impl Default for GuardrailsConfig {
    fn default() -> Self {
        Self {
            alert_only: true,
            paranoia_level: default_paranoia_level(),
            min_samples: default_min_samples(),
            fpr_margin: default_fpr_margin(),
            nearest_neighbor_audit: true,
        }
    }
}

fn default_paranoia_level() -> u8 {
    1
}

fn default_min_samples() -> u64 {
    50
}

fn default_fpr_margin() -> f64 {
    0.02
}

impl ZnConfig {
    /// A copy without the values `ZnConfig::default()` takes from the
    /// environment, so they are not written to a file. Keys and tokens
    /// (`ZN_API_KEY`, `ZN_JWT_SECRET`, `ZN_MCP_WS_TOKEN`, `ZN_DB_KEY`) are
    /// always cleared. The namespace and the KMS key id and region are cleared
    /// when they equal the current environment value (a value set in the
    /// config itself is kept). Cleared values are read from the environment
    /// again at start.
    pub fn without_env_values(&self) -> Self {
        fn same_as_env(value: &mut Option<String>, var: &str) {
            if let (Some(v), Ok(env)) = (value.as_ref(), std::env::var(var)) {
                if *v == env {
                    *value = None;
                }
            }
        }
        let mut config = self.clone();
        config.security.api_key = None;
        config.security.jwt_secret = None;
        config.security.mcp_ws_token = None;
        config.audit.encryption_key = None;
        same_as_env(&mut config.security.namespace, "ZN_NAMESPACE");
        same_as_env(&mut config.kms.key_id, "ZN_KMS_KEY_ID");
        same_as_env(&mut config.kms.region, "ZN_KMS_REGION");
        config
    }

    /// The configuration `zn init` writes: the defaults, without any value
    /// read from the environment.
    pub fn init_template() -> Self {
        Self::default().without_env_values()
    }

    /// Write `init_template()` to `path` as JSON, owner-only on Unix.
    pub fn write_init_file(path: &Path) -> Result<()> {
        Self::write_private_json(path, &Self::init_template())
    }

    /// Write `config` to `path` as pretty JSON through `write_private_file`.
    pub fn write_private_json(path: &Path, config: &Self) -> Result<()> {
        let json = serde_json::to_string_pretty(config)?;
        Self::write_private_file(path, json.as_bytes())
    }

    /// The one protected writer for files that hold configuration (zn.json
    /// and the locally saved synced config). It delegates to the shared
    /// private-file module: a new 0600 temporary file in the same directory is
    /// renamed over `path`, so a reader never sees a partial file and an
    /// existing regular file is replaced atomically and ends up owner-only. A
    /// `path` that is a symbolic link or is not a regular file (a directory, a
    /// FIFO, a device) is refused and left untouched.
    pub fn write_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
        crate::private_file::create_private_file(path, bytes)
            .map_err(|e| anyhow!("cannot write {}: {e}", path.display()))
    }

    /// Parse the text of a settings file. `file` is only used in the error
    /// message, which names the file and, when it can, the setting.
    pub fn parse_text(file: &str, content: &str) -> Result<Self> {
        serde_json::from_str(content).map_err(|e| anyhow!(config_parse_problem(file, content, &e)))
    }

    fn read_settings_file(path: &Path) -> Result<String> {
        std::fs::read_to_string(path).map_err(|e| {
            anyhow!(
                "zn could not read the settings file {}: {}. Check that the file exists and that this user can read it.",
                crate::user_errors::display_path(path),
                crate::user_errors::plain_text(&e.to_string())
            )
        })
    }

    /// Load configuration from file with environment variable overrides.
    /// Warnings about settings that were ignored are dropped here; use
    /// `load_with_notices` to show them.
    pub fn load(path: Option<&Path>) -> Result<Self> {
        Self::load_with_notices(path).map(|(config, _)| config)
    }

    /// Like `load`, and also returns plain-English warnings for settings that
    /// zn ignored: unknown keys in the file and an invalid `ZN_PORT`. An unknown key
    /// inside `security` or `audit` is an error instead, because ignoring a misspelt
    /// security setting would silently weaken it.
    ///
    /// An explicit `path` must exist and must be a `.json` file; otherwise the
    /// call fails with a message that says what to do.
    pub fn load_with_notices(path: Option<&Path>) -> Result<(Self, Vec<String>)> {
        let mut notices = Vec::new();
        let mut config = if let Some(p) = path {
            let shown = crate::user_errors::display_path(p);
            let is_json = p
                .extension()
                .map(|e| e.eq_ignore_ascii_case("json"))
                .unwrap_or(false);
            if !is_json {
                return Err(anyhow!(crate::user_errors::config_not_json(&shown)));
            }
            if !p.exists() {
                return Err(anyhow!(crate::user_errors::config_missing(&shown)));
            }
            let content = Self::read_settings_file(p)?;
            let config = Self::parse_text(&shown, &content)?;
            notices.extend(checked_setting_notices(&shown, &content)?);
            config
        } else {
            // Try to load from default locations
            let config_options = ["zn.json", "zn.config.json", ".zn.json"];
            let mut found = None;
            for option in config_options {
                let option_path = Path::new(option);
                if option_path.exists() {
                    let shown = crate::user_errors::display_path(option_path);
                    let content = Self::read_settings_file(option_path)?;
                    found = Some(Self::parse_text(&shown, &content)?);
                    notices.extend(checked_setting_notices(&shown, &content)?);
                    break;
                }
            }
            found.unwrap_or_default()
        };

        // Override with environment variables
        config.apply_env_overrides(&mut notices);

        Ok((config, notices))
    }

    /// Apply environment variable overrides
    fn apply_env_overrides(&mut self, notices: &mut Vec<String>) {
        if let Ok(env) = std::env::var("ZN_ENV") {
            self.environment = env;
        }

        if let Ok(port) = std::env::var("ZN_PORT") {
            match port.trim().parse() {
                Ok(p) => self.server.port = p,
                Err(_) => notices.push(crate::user_errors::invalid_port_env(
                    &port,
                    self.server.port,
                )),
            }
        }

        // A blank key (for example `ZN_API_KEY=` from an unset compose
        // variable) counts as not set: it must never match an empty token.
        self.security.api_key = credential_override(
            self.security.api_key.take(),
            std::env::var("ZN_API_KEY").ok(),
        );

        if let Ok(ns) = std::env::var("ZN_NAMESPACE") {
            self.security.namespace = Some(ns);
        }

        if let Ok(jwt) = std::env::var("ZN_JWT_SECRET") {
            self.security.jwt_secret = Some(jwt);
        }

        if let Ok(origins) = std::env::var("ZN_ALLOWED_ORIGINS") {
            self.security.allowed_origins =
                origins.split(',').map(|s| s.trim().to_string()).collect();
        }

        // A blank token counts as not set; the gateway then generates one.
        self.security.mcp_ws_token = credential_override(
            self.security.mcp_ws_token.take(),
            std::env::var("ZN_MCP_WS_TOKEN").ok(),
        );

        if let Ok(gas) = std::env::var("ZN_GAS_LIMIT") {
            if let Ok(g) = gas.parse() {
                self.engine.gas_limit = g;
            }
        }

        if let Ok(mem) = std::env::var("ZN_MEMORY_LIMIT") {
            if let Ok(m) = mem.parse() {
                self.engine.memory_limit_mb = m;
            }
        }

        if let Ok(to) = std::env::var("ZN_TIMEOUT") {
            if let Ok(t) = to.parse() {
                self.engine.timeout_ms = t;
            }
        }

        if let Ok(hashes) = std::env::var("ZN_POLICY_HASHES") {
            self.engine.allowed_policy_hashes = hashes.split(',').map(|s| s.to_string()).collect();
        }

        if let Ok(key) = std::env::var("ZN_SIGNING_PUBLIC_KEY") {
            self.engine.signing_public_key = Some(key);
        }

        if let Ok(db) = std::env::var("ZN_DB_PATH") {
            self.audit.db_path = db;
        }

        if let Ok(key) = std::env::var("ZN_DB_KEY") {
            self.audit.encryption_key = Some(key);
            self.audit.encryption_enabled = true;
        }

        if let Ok(v) = std::env::var("ZN_AUDIT_STORE_PAYLOADS") {
            self.audit.store_payloads = matches!(v.trim(), "1" | "true" | "TRUE" | "True");
        }

        if let Ok(v) = std::env::var("ZN_AUDIT_REQUIRE_WRITE") {
            self.audit.require_write = matches!(v.trim(), "1" | "true" | "TRUE" | "True");
        }

        if let Ok(endpoint) = std::env::var("ZN_SIEM_ENDPOINT") {
            self.siem.endpoint = Some(endpoint);
        }

        if let Ok(token) = std::env::var("ZN_SIEM_TOKEN") {
            self.siem.token = Some(token);
        }

        if let Ok(kms_type) = std::env::var("ZN_KMS_TYPE") {
            self.kms.kms_type = kms_type;
        }

        if let Ok(key_id) = std::env::var("ZN_KMS_KEY_ID") {
            self.kms.key_id = Some(key_id);
        }

        if let Ok(allow) = std::env::var("ZN_KMS_ALLOW_CONFIG_FALLBACK") {
            self.kms.allow_config_fallback =
                matches!(allow.as_str(), "1" | "true" | "TRUE" | "True");
        }

        if let Ok(neural_enabled) = std::env::var("ZN_NEURAL_ENABLED") {
            self.neural.enabled = neural_enabled.parse().unwrap_or(true);
        }

        if let Ok(neural_threshold) = std::env::var("ZN_NEURAL_THRESHOLD") {
            if let Ok(t) = neural_threshold.parse() {
                self.neural.threshold = t;
            }
        }

        if let Ok(active_blocking) = std::env::var("ZN_NEURAL_BLOCKING") {
            self.neural.active_blocking = active_blocking.parse().unwrap_or(false);
        }

        if let Ok(alert_only) = std::env::var("ZN_GUARDRAILS_ALERT_ONLY") {
            self.guardrails.alert_only = alert_only.parse().unwrap_or(true);
        }

        if let Ok(paranoia) = std::env::var("ZN_PARANOIA_LEVEL") {
            if let Ok(lvl) = paranoia.parse::<u8>() {
                self.guardrails.paranoia_level = lvl.clamp(1, 5);
            }
        }

        if let Ok(min_s) = std::env::var("ZN_MIN_SAMPLES") {
            if let Ok(v) = min_s.parse::<u64>() {
                self.guardrails.min_samples = v;
            }
        }

        if let Ok(margin) = std::env::var("ZN_FPR_MARGIN") {
            if let Ok(m) = margin.parse::<f64>() {
                self.guardrails.fpr_margin = m;
            }
        }

        if let Ok(nn_audit) = std::env::var("ZN_NEAREST_NEIGHBOR_AUDIT") {
            self.guardrails.nearest_neighbor_audit = nn_audit.parse().unwrap_or(true);
        }
    }

    /// Validate configuration
    pub fn validate(&self) -> Result<()> {
        if let Some(secret) = &self.security.jwt_secret {
            if secret.len() < MIN_JWT_SECRET_BYTES {
                return Err(anyhow!(
                    "ZN_JWT_SECRET must be at least {} bytes (for example `openssl rand -hex 32`)",
                    MIN_JWT_SECRET_BYTES
                ));
            }
        }

        if self.security.rate_limit_per_minute < 1 {
            return Err(anyhow!(
                "security.rate_limit_per_minute must be at least 1 (allowed range: 1 to {}), but it is {}.",
                u32::MAX,
                self.security.rate_limit_per_minute
            ));
        }

        if self.caching.ttl_seconds > MAX_CACHE_TTL_SECONDS {
            return Err(anyhow!(
                "caching.ttl_seconds must be between 0 and {} (one year), but it is {}",
                MAX_CACHE_TTL_SECONDS,
                self.caching.ttl_seconds
            ));
        }

        if self.security.api_key.is_none() && self.environment == "production" {
            tracing::warn!("No API key configured in production - Management API is unprotected!");
        }

        if self.security.allowed_origins.is_empty() {
            tracing::info!("No CORS origins configured - only localhost will be allowed");
        }

        if self.environment == "production"
            && (!self.audit.encryption_enabled || self.audit.encryption_key.is_none())
        {
            return Err(anyhow!(
                "Audit log encryption is MANDATORY in production. Please set ZN_DB_KEY."
            ));
        }

        if self.audit.store_payloads
            && self.kms.key_id.is_none()
            && (!self.audit.encryption_enabled || self.audit.encryption_key.is_none())
        {
            return Err(anyhow!(
                "audit.store_payloads needs an encryption key: set ZN_DB_KEY, or leave payloads off (the default)."
            ));
        }

        Ok(())
    }

    /// Get neural blocking mode based on paranoia level and alert_only
    pub fn is_neural_blocking(&self) -> bool {
        !self.guardrails.alert_only && self.neural.active_blocking
    }

    /// Get paranoia-adjusted threshold multiplier
    pub fn paranoia_threshold_multiplier(&self) -> f32 {
        match self.guardrails.paranoia_level {
            1 => 1.5, // relaxed
            2 => 1.2, // normal
            3 => 1.0, // balanced
            4 => 0.8, // strict
            5 => 0.6, // paranoid
            _ => 1.0,
        }
    }

    /// Get paranoia-adjusted classifier threshold
    pub fn paranoia_classifier_threshold(&self) -> f32 {
        match self.guardrails.paranoia_level {
            1 => 0.7, // relaxed
            2 => 0.6, // normal
            3 => 0.5, // balanced
            4 => 0.4, // strict
            5 => 0.3, // paranoid
            _ => 0.5,
        }
    }
}

/// Plain wording for a value of the wrong type: serde's `u16` becomes
/// "a whole number from 0 to 65535" and so on.
fn plain_expected(want: &str) -> String {
    match want.trim() {
        "u8" => "a whole number from 0 to 255".to_string(),
        "u16" => "a whole number from 0 to 65535".to_string(),
        "u32" | "u64" | "u128" | "usize" => "a whole number, 0 or more".to_string(),
        "i8" | "i16" | "i32" | "i64" | "i128" | "isize" => "a whole number".to_string(),
        "f32" | "f64" => "a number".to_string(),
        "a boolean" | "bool" => "true or false".to_string(),
        "a string" | "String" => "text in quotes".to_string(),
        "a sequence" => "a list in [ ]".to_string(),
        "a map" | "struct" => "a group of settings in { }".to_string(),
        other => other.to_string(),
    }
}

/// Plain wording for the value that was found ("the text \"eighty\"").
fn plain_found(got: &str) -> String {
    let got = got.trim();
    if let Some(rest) = got.strip_prefix("string ") {
        return format!("the text {rest}");
    }
    if let Some(rest) = got
        .strip_prefix("integer ")
        .or_else(|| got.strip_prefix("floating point "))
    {
        return format!("the number {}", rest.trim_matches('`'));
    }
    if let Some(rest) = got.strip_prefix("boolean ") {
        return format!("the value {}", rest.trim_matches('`'));
    }
    match got {
        "null" | "unit value" => "an empty value (null)".to_string(),
        "sequence" => "a list".to_string(),
        "map" => "a group of settings".to_string(),
        other => other.to_string(),
    }
}

/// What is wrong with a value, from serde's message about it.
fn plain_data_problem(msg: &str) -> String {
    // serde appends the position: " at line 1 column 30".
    let msg = match msg.rfind(" at line ") {
        Some(i) => &msg[..i],
        None => msg,
    };
    for prefix in ["invalid type: ", "invalid value: "] {
        if let Some(rest) = msg.strip_prefix(prefix) {
            if let Some((got, want)) = rest.split_once(", expected ") {
                return format!(
                    "it must be {}, but it is {}",
                    plain_expected(want),
                    plain_found(got)
                );
            }
        }
    }
    if let Some(rest) = msg.strip_prefix("missing field `") {
        return format!(
            "the required setting `{}` is missing",
            rest.trim_end_matches('`')
        );
    }
    msg.to_string()
}

/// The setting that serde could not accept, as `section.key`, found by giving
/// every setting of the file alone to the parser. None when it cannot be told.
fn find_bad_setting(content: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(content).ok()?;
    let top = value.as_object()?;
    // The probe only means something when an empty file is a valid config.
    serde_json::from_value::<ZnConfig>(serde_json::json!({})).ok()?;
    let bad = |v: serde_json::Value| serde_json::from_value::<ZnConfig>(v).is_err();
    for (key, val) in top {
        if !bad(serde_json::json!({ key: val })) {
            continue;
        }
        if let Some(inner) = val.as_object() {
            for (key2, val2) in inner {
                if bad(serde_json::json!({ key: { key2: val2 } })) {
                    return Some(format!("{key}.{key2}"));
                }
            }
        }
        return Some(key.clone());
    }
    None
}

/// Every setting name zn knows, as dotted paths (`server.port`), taken from
/// the default configuration so the list can never fall behind the structs.
fn known_setting_paths() -> Vec<String> {
    fn walk(prefix: &str, value: &serde_json::Value, out: &mut Vec<String>) {
        if let Some(map) = value.as_object() {
            for (key, inner) in map {
                let path = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                out.push(path.clone());
                walk(&path, inner, out);
            }
        }
    }
    let mut out = Vec::new();
    if let Ok(value) = serde_json::to_value(ZnConfig::default()) {
        walk("", &value, &mut out);
    }
    out
}

/// Settings in `content` that zn does not know, as dotted paths. Keys that
/// start with `_` or `$` (comments, `$schema`) are not reported.
pub fn unknown_settings(content: &str) -> Vec<String> {
    fn walk(
        prefix: &str,
        file: &serde_json::Value,
        known: &serde_json::Value,
        out: &mut Vec<String>,
    ) {
        let (Some(file_map), Some(known_map)) = (file.as_object(), known.as_object()) else {
            return;
        };
        for (key, inner) in file_map {
            if key.starts_with('_') || key.starts_with('$') {
                continue;
            }
            let path = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{prefix}.{key}")
            };
            match known_map.get(key) {
                None => out.push(path),
                Some(known_inner) => walk(&path, inner, known_inner, out),
            }
        }
    }
    let (Ok(file), Ok(known)) = (
        serde_json::from_str::<serde_json::Value>(content),
        serde_json::to_value(ZnConfig::default()),
    ) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    walk("", &file, &known, &mut out);
    out
}

fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur.push((prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1));
        }
        prev = cur;
    }
    prev[b.len()]
}

/// The known setting that `unknown` was most likely meant to be: a name close
/// to it in the same section, or else the same name in another section.
fn suggest_setting(unknown: &str, known: &[String]) -> Option<String> {
    let (section, last) = match unknown.rfind('.') {
        Some(i) => (&unknown[..i], &unknown[i + 1..]),
        None => ("", unknown),
    };
    let limit = if last.chars().count() <= 3 { 1 } else { 2 };
    let mut best: Option<(usize, &String)> = None;
    for k in known {
        let (k_section, k_last) = match k.rfind('.') {
            Some(i) => (&k[..i], &k[i + 1..]),
            None => ("", k.as_str()),
        };
        if k_section != section {
            continue;
        }
        let d = edit_distance(&last.to_lowercase(), &k_last.to_lowercase());
        if d <= limit && best.map(|(bd, _)| d < bd).unwrap_or(true) {
            best = Some((d, k));
        }
    }
    if let Some((_, k)) = best {
        return Some(k.clone());
    }
    known
        .iter()
        .find(|k| k.rsplit('.').next() == Some(last))
        .cloned()
}

/// One warning per unknown setting in `content`.
fn unknown_setting_notices(file: &str, content: &str) -> Vec<String> {
    let unknown = unknown_settings(content);
    if unknown.is_empty() {
        return Vec::new();
    }
    let known = known_setting_paths();
    unknown
        .iter()
        .map(|u| {
            crate::user_errors::unknown_setting(file, u, suggest_setting(u, &known).as_deref())
        })
        .collect()
}

/// True for a setting inside the `security` or `audit` sections.
fn is_security_setting(path: &str) -> bool {
    path.starts_with("security.") || path.starts_with("audit.")
}

/// Like `unknown_setting_notices`, but an unknown key inside `security` or `audit` is an
/// error that names the key and the closest valid one. Other unknown keys stay warnings.
fn checked_setting_notices(file: &str, content: &str) -> Result<Vec<String>> {
    let unknown = unknown_settings(content);
    if let Some(bad) = unknown.iter().find(|u| is_security_setting(u)) {
        let known = known_setting_paths();
        return Err(anyhow!(crate::user_errors::unknown_security_setting(
            file,
            bad,
            suggest_setting(bad, &known).as_deref()
        )));
    }
    Ok(unknown_setting_notices(file, content))
}

/// Plain-English text for a settings file that cannot be parsed: the file, the
/// setting if it is known, the line, and what to do.
pub fn config_parse_problem(file: &str, content: &str, err: &serde_json::Error) -> String {
    use serde_json::error::Category;
    let at = format!("line {}, column {}", err.line(), err.column());
    let fix =
        String::from("Fix the file, or move it away and run `zn init` to create a fresh zn.json.");
    match err.classify() {
        Category::Eof => format!(
            "zn could not read the settings file {file}: the file ends too early ({at}). A closing }} or ] is probably missing. {fix}"
        ),
        Category::Syntax => format!(
            "zn could not read the settings file {file}: it is not valid JSON at {at} ({}). Look for a missing comma or quote, or a comma after the last item. {fix}",
            plain_serde_syntax(&err.to_string())
        ),
        Category::Data => {
            let what = plain_data_problem(&err.to_string());
            match find_bad_setting(content) {
                Some(setting) => format!(
                    "zn could not use the settings file {file}: the setting \"{setting}\" has a wrong value ({what}). Correct that value ({at}). {fix}"
                ),
                None => format!(
                    "zn could not use the settings file {file}: a setting has a wrong value ({what}) near {at}. Correct that value. {fix}"
                ),
            }
        }
        Category::Io => format!("zn could not read the settings file {file}: {err}"),
    }
}

/// serde's syntax message without its position suffix.
fn plain_serde_syntax(msg: &str) -> String {
    match msg.rfind(" at line ") {
        Some(i) => msg[..i].to_string(),
        None => msg.to_string(),
    }
}

#[cfg(test)]
mod jwt_secret_tests {
    use super::*;

    #[test]
    fn short_jwt_secret_is_refused() {
        let mut config = ZnConfig::default();
        config.security.jwt_secret = None;
        assert!(config.validate().is_ok());
        let one_byte_short = "x".repeat(MIN_JWT_SECRET_BYTES - 1);
        for short in ["", "secret", one_byte_short.as_str()] {
            config.security.jwt_secret = Some(short.to_string());
            assert!(config.validate().is_err(), "{} bytes", short.len());
        }
        config.security.jwt_secret = Some("x".repeat(MIN_JWT_SECRET_BYTES));
        assert!(config.validate().is_ok());
    }
}

#[cfg(test)]
mod rate_limit_tests {
    use super::*;

    #[test]
    fn zero_rate_limit_is_refused_with_the_allowed_range() {
        let mut config = ZnConfig::default();
        config.security.jwt_secret = None;
        config.security.rate_limit_per_minute = 0;
        let err = config
            .validate()
            .expect_err("0 must be refused")
            .to_string();
        assert!(err.contains("rate_limit_per_minute"), "{err}");
        assert!(err.contains("at least 1"), "{err}");
        for ok in [1, 60, u32::MAX] {
            config.security.rate_limit_per_minute = ok;
            assert!(config.validate().is_ok(), "{ok}");
        }
    }
}

#[cfg(test)]
mod cache_ttl_tests {
    use super::*;

    #[test]
    fn cache_ttl_above_one_year_is_refused() {
        let mut config = ZnConfig::default();
        config.security.jwt_secret = None;
        for ok in [0, 1, 300, MAX_CACHE_TTL_SECONDS] {
            config.caching.ttl_seconds = ok;
            assert!(config.validate().is_ok(), "{ok}");
        }
        for bad in [MAX_CACHE_TTL_SECONDS + 1, i64::MAX as u64, u64::MAX] {
            config.caching.ttl_seconds = bad;
            let err = config.validate().expect_err("too large").to_string();
            assert!(err.contains("caching.ttl_seconds"), "{err}");
            assert!(err.contains("one year"), "{err}");
        }
    }
}

#[cfg(test)]
mod credential_tests {
    use super::*;

    fn some(v: &str) -> Option<String> {
        Some(v.to_string())
    }

    #[test]
    fn blank_credentials_count_as_not_set() {
        for blank in ["", " ", "   ", "\t", "\n", " \r\n"] {
            assert_eq!(normalize_credential(some(blank)), None, "{blank:?}");
        }
        assert_eq!(normalize_credential(None), None);
    }

    #[test]
    fn credentials_are_trimmed() {
        assert_eq!(normalize_credential(some("  key\n")), some("key"));
        assert_eq!(normalize_credential(some("k e y")), some("k e y"));
    }

    #[test]
    fn environment_overrides_the_config_file() {
        // ZN_API_KEY= (blank) unsets a key from the config file.
        assert_eq!(credential_override(some("file-key"), some("")), None);
        assert_eq!(credential_override(some("file-key"), some("   ")), None);
        // A set variable wins, trimmed.
        assert_eq!(
            credential_override(some("file-key"), some(" env-key ")),
            some("env-key")
        );
        // Without the variable the file value is kept, normalized.
        assert_eq!(
            credential_override(some(" file-key "), None),
            some("file-key")
        );
        assert_eq!(credential_override(some("  "), None), None);
        assert_eq!(credential_override(None, None), None);
    }

    #[test]
    fn security_config_debug_hides_secrets() {
        let c = SecurityConfig {
            api_key: Some("fake-api-key-0000".to_string()),
            jwt_secret: Some("fake-jwt-secret-0000".to_string()),
            mcp_ws_token: Some("fake-ws-token-0000".to_string()),
            ..SecurityConfig::default()
        };
        let out = format!("{:?} {:#?}", c, c);
        for secret in [
            "fake-api-key-0000",
            "fake-jwt-secret-0000",
            "fake-ws-token-0000",
        ] {
            assert!(!out.contains(secret), "{secret} leaked");
        }
        assert!(out.contains("<redacted>"));
    }
}

#[cfg(test)]
mod audit_payload_tests {
    use super::*;

    #[test]
    fn payload_storage_is_off_by_default() {
        assert!(!AuditConfig::default().store_payloads);
        let parsed: AuditConfig = serde_json::from_str("{}").unwrap();
        assert!(!parsed.store_payloads);
    }

    #[test]
    fn payload_storage_without_a_key_is_refused() {
        let mut cfg = ZnConfig::default();
        cfg.audit.store_payloads = true;
        cfg.audit.encryption_enabled = false;
        cfg.audit.encryption_key = None;
        cfg.kms.key_id = None;
        let err = cfg.validate().unwrap_err().to_string();
        assert!(err.contains("store_payloads"), "{err}");
    }

    #[test]
    fn payload_storage_with_a_key_passes_that_check() {
        let mut cfg = ZnConfig::default();
        cfg.audit.store_payloads = true;
        cfg.audit.encryption_enabled = true;
        cfg.audit.encryption_key = Some("example-passphrase-not-secret".into());
        if let Err(e) = cfg.validate() {
            assert!(!e.to_string().contains("store_payloads"), "{e}");
        }
    }
}

#[cfg(test)]
mod parse_message_tests {
    use super::*;

    fn problem(text: &str) -> String {
        let err = serde_json::from_str::<ZnConfig>(text).expect_err("must not parse");
        config_parse_problem("/work/zn.json", text, &err)
    }

    #[test]
    fn truncated_file_names_the_file_and_the_next_step() {
        let msg = problem("{\n");
        assert!(msg.contains("/work/zn.json"), "{msg}");
        assert!(msg.contains("ends too early"), "{msg}");
        assert!(msg.contains("zn init"), "{msg}");
        assert!(!msg.contains("EOF while parsing"), "{msg}");
    }

    #[test]
    fn wrong_type_names_the_setting_in_plain_words() {
        let msg = problem(r#"{"server": {"port": "eighty"}}"#);
        assert!(msg.contains("/work/zn.json"), "{msg}");
        assert!(msg.contains("\"server.port\""), "{msg}");
        assert!(msg.contains("whole number from 0 to 65535"), "{msg}");
        assert!(msg.contains("the text \"eighty\""), "{msg}");
        assert!(!msg.contains("u16"), "{msg}");
        assert!(msg.contains("zn init"), "{msg}");
    }

    #[test]
    fn wrong_type_in_a_top_level_setting_is_named() {
        let msg = problem(r#"{"environment": 5}"#);
        assert!(msg.contains("\"environment\""), "{msg}");
    }

    #[test]
    fn broken_syntax_points_at_the_line() {
        let msg = problem("{\n  \"server\": {,}\n}");
        assert!(msg.contains("not valid JSON at line 2"), "{msg}");
        assert!(msg.contains("/work/zn.json"), "{msg}");
    }

    #[test]
    fn load_reports_the_file_that_failed() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("bad.json");
        std::fs::write(&file, "{\"server\": {\"port\": \"eighty\"}}").expect("write");
        let err = ZnConfig::load(Some(&file)).expect_err("a bad file must not load");
        let msg = err.to_string();
        assert!(msg.contains("bad.json"), "{msg}");
        assert!(msg.contains("server.port"), "{msg}");
    }

    #[test]
    fn a_misspelled_setting_is_reported_with_a_suggestion() {
        let notices = unknown_setting_notices("zn.json", "{\"server\": {\"prot\": 1}}");
        assert_eq!(notices.len(), 1, "{notices:?}");
        assert!(
            notices[0].contains("\"server.prot\" was ignored"),
            "{notices:?}"
        );
        assert!(
            notices[0].contains("did you mean \"server.port\""),
            "{notices:?}"
        );
    }

    #[test]
    fn a_setting_in_the_wrong_section_points_to_the_right_one() {
        let notices = unknown_setting_notices("zn.json", "{\"port\": 1}");
        assert!(
            notices[0].contains("did you mean \"server.port\""),
            "{notices:?}"
        );
    }

    #[test]
    fn an_unrelated_setting_gets_no_guess() {
        let notices = unknown_setting_notices("zn.json", "{\"flavour\": 1}");
        assert!(
            notices[0].contains("\"flavour\" was ignored"),
            "{notices:?}"
        );
        assert!(!notices[0].contains("did you mean"), "{notices:?}");
    }

    #[test]
    fn the_file_zn_init_writes_has_no_unknown_settings() {
        let json = serde_json::to_string_pretty(&ZnConfig::init_template()).expect("json");
        assert!(unknown_settings(&json).is_empty());
    }

    #[test]
    fn an_unknown_key_in_security_or_audit_is_an_error() {
        let err = checked_setting_notices("zn.json", "{\"security\": {\"block_unkown\": true}}")
            .expect_err("a misspelt security key must fail");
        let msg = err.to_string();
        assert!(msg.contains("security.block_unkown"), "{msg}");
        let err = checked_setting_notices("zn.json", "{\"audit\": {\"encryption_enabld\": true}}")
            .expect_err("a misspelt audit key must fail");
        let msg = err.to_string();
        assert!(msg.contains("audit.encryption_enabld"), "{msg}");
        assert!(msg.contains("did you mean \"audit.encryption_enabled\""), "{msg}");
    }

    #[test]
    fn an_unknown_key_in_another_section_is_still_a_warning() {
        let notices = checked_setting_notices("zn.json", "{\"server\": {\"prot\": 1}}")
            .expect("other sections only warn");
        assert_eq!(notices.len(), 1, "{notices:?}");
    }

    #[test]
    fn loading_a_file_with_a_misspelt_security_key_fails() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("zn.json");
        std::fs::write(&file, "{\"audit\": {\"encryption_enabld\": false}}").expect("write");
        let err = ZnConfig::load_with_notices(Some(&file)).expect_err("must not load");
        assert!(err.to_string().contains("audit.encryption_enabld"), "{err}");
    }

    #[test]
    fn the_init_template_loads_without_notices_or_errors() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("zn.json");
        let json = serde_json::to_string_pretty(&ZnConfig::init_template()).expect("json");
        std::fs::write(&file, json).expect("write");
        let (_, notices) = ZnConfig::load_with_notices(Some(&file)).expect("template loads");
        assert!(notices.iter().all(|n| !n.contains("unknown")), "{notices:?}");
    }

    #[test]
    fn comment_and_schema_keys_are_not_reported() {
        assert!(unknown_settings("{\"$schema\": \"x\", \"_note\": \"y\"}").is_empty());
    }

    #[test]
    fn a_missing_config_file_is_an_error() {
        let dir = tempfile::tempdir().expect("temp dir");
        let err = ZnConfig::load(Some(&dir.path().join("nope.json"))).expect_err("must fail");
        let msg = err.to_string();
        assert!(
            msg.contains("nope.json") && msg.contains("does not exist"),
            "{msg}"
        );
        assert!(msg.contains("zn init"), "{msg}");
    }

    #[test]
    fn a_config_file_that_is_not_json_is_an_error() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("zn.toml");
        std::fs::write(&file, "port = 1").expect("write");
        let err = ZnConfig::load(Some(&file)).expect_err("must fail");
        let msg = err.to_string();
        assert!(
            msg.contains("zn.toml") && msg.contains("not a JSON file"),
            "{msg}"
        );
    }

    #[test]
    fn an_invalid_port_variable_is_reported_and_the_port_is_kept() {
        let mut config = ZnConfig::default();
        config.server.port = 9090;
        let mut notices = Vec::new();
        std::env::set_var("ZN_PORT", "abc");
        config.apply_env_overrides(&mut notices);
        std::env::remove_var("ZN_PORT");
        assert_eq!(config.server.port, 9090);
        assert_eq!(notices.len(), 1);
        assert!(
            notices[0].contains("ZN_PORT=\"abc\"") && notices[0].contains("9090"),
            "{notices:?}"
        );
    }
}
