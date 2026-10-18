//! Audit Vault Module
//!
//! Provides persistent storage for security audit logs using SQLite.
//!
//! ## Features
//! - Thread-safe database access via Arc<Mutex<Connection>>
//! - Automatic table creation on initialization
//! - Efficient query for recent entries

pub mod exporter;

#[cfg(test)]
mod kat_tests;

use crate::metrics;
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

/// Represents a single audit event in the system
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    /// Unique event identifier
    pub id: String,
    /// ISO 8601 timestamp
    pub timestamp: String,
    /// Event type (e.g., TOOL_CALL, POLICY_DENY)
    pub event: String,
    /// Name of the tool involved
    pub tool_name: String,
    /// Operation status (ALLOWED, DENIED)
    pub status: String,
    /// Name of the policy that matched
    pub policy_match: Option<String>,
    /// Scrubbed JSON-RPC payload
    pub payload: Option<String>,
    /// ID of the agent that made the request
    pub agent_id: Option<String>,
    /// Multi-tenant namespace
    pub namespace: Option<String>,
    /// Neural anomaly score (0.0 to 1.0 or higher)
    pub anomaly_score: Option<f32>,
    /// Nearest neighbor entry for audit (format: "text:distance")
    pub nearest_neighbor: Option<String>,
    /// B-3 Fusion Gate evidence; present only when the neural camera
    /// participated in a block decision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fusion: Option<FusionEvidence>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VaultStats {
    pub total: usize,
    pub allowed: usize,
    pub denied: usize,
}

impl AuditEntry {
    /// Create a new audit entry with the current timestamp
    pub fn new(
        event: impl Into<String>,
        tool_name: impl Into<String>,
        status: impl Into<String>,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            timestamp: Utc::now().to_rfc3339(),
            event: event.into(),
            tool_name: tool_name.into(),
            status: status.into(),
            policy_match: None,
            payload: None,
            agent_id: None,
            namespace: None,
            anomaly_score: None,
            nearest_neighbor: None,
            fusion: None,
        }
    }

    pub fn with_policy(mut self, policy: impl Into<String>) -> Self {
        self.policy_match = Some(policy.into());
        self
    }

    pub fn with_payload(mut self, payload: impl Into<String>) -> Self {
        self.payload = Some(payload.into());
        self
    }

    pub fn with_agent_id(mut self, agent_id: impl Into<String>) -> Self {
        self.agent_id = Some(agent_id.into());
        self
    }

    pub fn with_nearest_neighbor(mut self, nn: impl Into<String>) -> Self {
        self.nearest_neighbor = Some(nn.into());
        self
    }

    /// B-3: attach Fusion Gate evidence (block events, fusion active only).
    pub fn with_fusion(mut self, fusion: FusionEvidence) -> Self {
        self.fusion = Some(fusion);
        self
    }
}

/// B-3 Fusion Gate evidence: which cameras fired plus the neural inputs that
/// produced the decision. Attached to audit entries only when the neural
/// camera actively participated AND the call was blocked.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FusionEvidence {
    /// Cameras that fired, e.g. ["rules", "neural"].
    pub cameras: Vec<String>,
    /// Head probability in [0, 1] at decision time.
    pub neural_score: f32,
    /// Threshold applied to `neural_score`.
    pub tau: f32,
    /// Model version id (must match the exported score fixture).
    pub model_id: String,
}

/// Derive the 32-byte AES-256-GCM key from a passphrase and the per-database salt.
///
/// Argon2id, version 0x13, m = 19456 KiB, t = 2, p = 1 (the `Argon2::default()` parameters).
/// Existing audit databases depend on this exact output; `kat_tests` pins it.
fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; 32]> {
    let mut key = [0u8; 32];
    argon2::Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| anyhow!("Failed to derive encryption key: {}", e))?;
    Ok(key)
}

/// Persistent storage for audit logs with built-in encryption support
pub struct AuditVault {
    conn: Arc<Mutex<Connection>>,
    #[allow(dead_code)]
    db_path: String,
    /// Key for payload encryption (AES-256-GCM)
    encryption_key: Option<[u8; 32]>,
}

impl AuditVault {
    /// Create a new AuditVault, initializing the database schema if needed
    pub fn new(db_path: &str, encryption_key: Option<&str>) -> Result<Self> {
        info!("Initializing AuditVault at: {}", db_path);

        let mut conn = Connection::open(db_path)
            .map_err(|e| anyhow!("Failed to open audit database '{}': {}", db_path, e))?;

        // Create metadata table for persistent configuration (like salt)
        conn.execute(
            "CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )",
            [],
        )
        .map_err(|e| anyhow!("Failed to create metadata table: {}", e))?;

        // Derive key if provided
        let derived_key = if let Some(key_str) = encryption_key {
            // Get or create random salt
            let mut stmt =
                conn.prepare("SELECT value FROM metadata WHERE key = 'derivation_salt'")?;
            let salt_hex: Option<String> = stmt.query_row([], |row| row.get(0)).ok();

            let salt = if let Some(hex_str) = salt_hex {
                hex::decode(hex_str).map_err(|e| anyhow!("Failed to decode salt: {}", e))?
            } else {
                use rand::Rng;
                let mut new_salt = [0u8; 16];
                rand::rng().fill_bytes(&mut new_salt);
                let hex_str = hex::encode(new_salt);
                conn.execute(
                    "INSERT INTO metadata (key, value) VALUES ('derivation_salt', ?1)",
                    [hex_str],
                )?;
                new_salt.to_vec()
            };

            let key = derive_key(key_str, &salt)?;
            info!("Audit encryption enabled with persistent salt");
            Some(key)
        } else {
            None
        };

        // Create table with index for efficient timestamp queries
        conn.execute(
            "CREATE TABLE IF NOT EXISTS audit_logs (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                event TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                status TEXT NOT NULL,
                policy_match TEXT,
                payload TEXT,
                agent_id TEXT,
                namespace TEXT,
                anomaly_score REAL,
                nearest_neighbor TEXT,
                fusion TEXT
            )",
            [],
        )
        .map_err(|e| anyhow!("Failed to create audit_logs table: {}", e))?;

        // Migration: add nearest_neighbor column if missing (E-2)
        // Check if column exists first
        let has_column: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('audit_logs') WHERE name = 'nearest_neighbor'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if !has_column {
            info!("Adding nearest_neighbor column via migration");
            conn.execute(
                "ALTER TABLE audit_logs ADD COLUMN nearest_neighbor TEXT",
                [],
            )
            .ok();
        }

        // Migration: add fusion column if missing (B-3)
        let has_fusion: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('audit_logs') WHERE name = 'fusion'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if !has_fusion {
            info!("Adding fusion evidence column via migration");
            conn.execute("ALTER TABLE audit_logs ADD COLUMN fusion TEXT", [])
                .ok();
        }

        // Upgrade records written in the old format the first time the vault
        // opens with its key. A key that fails the stored key check is refused
        // before anything is written.
        if let Some(key) = &derived_key {
            let had_key_check = verify_key_check(&conn, key)?;
            if !had_key_check {
                refuse_if_no_bound_record_opens(&conn, key)?;
            }
            let report = migrate_v1_records(&mut conn, key, had_key_check)?;
            if !had_key_check {
                write_key_check_if_verified(&conn, key, report.unreadable)?;
            }
            if report.migrated > 0 {
                info!(
                    "Audit records upgraded to the bound format: {}",
                    report.migrated
                );
            }
            if report.unreadable > 0 {
                warn!(
                    "{} old-format audit records could not be read with this key and were left unchanged",
                    report.unreadable
                );
            }
            if report.not_encrypted > 0 {
                warn!(
                    "{} audit records are not encrypted and were left unchanged",
                    report.not_encrypted
                );
            }
        }

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path: db_path.to_string(),
            encryption_key: derived_key,
        })
    }

    /// Store a new audit entry in the database
    pub fn log(&self, entry: AuditEntry) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow!("Lock poisoned: {}", e))?;

        // Encrypt payload if key is available
        let payload = if let (Some(key_bytes), Some(p_raw)) = (&self.encryption_key, &entry.payload)
        {
            let encoded = encrypt_payload(key_bytes, &entry.id, entry.namespace.as_deref(), p_raw)?;
            Some(encoded)
        } else {
            entry.payload.clone()
        };

        let nearest_neighbor = entry.nearest_neighbor.clone();
        let fusion = entry
            .fusion
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| anyhow!("Fusion evidence serialization failed: {}", e))?;
        conn.execute(
            "INSERT INTO audit_logs (id, timestamp, event, tool_name, status, policy_match, payload, agent_id, namespace, anomaly_score, nearest_neighbor, fusion)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                entry.id,
                entry.timestamp,
                entry.event,
                entry.tool_name,
                entry.status,
                entry.policy_match,
                payload,
                entry.agent_id,
                entry.namespace,
                entry.anomaly_score,
                nearest_neighbor,
                fusion,
            ],
        ).map_err(|e| {
            error!("Failed to log audit entry: {}", e);
            anyhow!("Database error: {}", e)
        })?;

        debug!("Audited event: {} by tool {}", entry.event, entry.tool_name);
        metrics::record_audit_entry();
        Ok(())
    }

    /// Retrieve recent audit logs from the database
    pub fn get_recent(&self, limit: usize) -> Result<Vec<AuditEntry>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow!("Lock poisoned: {}", e))?;

        let mut stmt = conn.prepare(
            "SELECT id, timestamp, event, tool_name, status, policy_match, payload, agent_id, namespace, anomaly_score, nearest_neighbor, fusion
             FROM audit_logs ORDER BY timestamp DESC LIMIT ?"
        ).map_err(|e| anyhow!("Failed to prepare query: {}", e))?;

        let entries = stmt
            .query_map([limit], |row: &Row| {
                let id: String = row.get(0)?;
                let timestamp: String = row.get(1)?;
                let event: String = row.get(2)?;
                let tool_name: String = row.get(3)?;
                let status: String = row.get(4)?;
                let policy_match: Option<String> = row.get(5)?;
                let mut payload: Option<String> = row.get(6)?;
                let agent_id: Option<String> = row.get(7)?;
                let namespace: Option<String> = row.get(8)?;
                let anomaly_score: Option<f32> = row.get(9)?;
                let nearest_neighbor: Option<String> = row.get(10)?;
                let fusion: Option<String> = row.get(11)?;
                let fusion: Option<FusionEvidence> =
                    fusion.and_then(|s| serde_json::from_str(&s).ok());

                // Decrypt payload if key is available
                if let (Some(key_bytes), Some(p_enc)) = (&self.encryption_key, &payload) {
                    if let Some(s) = decrypt_payload(key_bytes, &id, namespace.as_deref(), p_enc) {
                        payload = Some(s);
                    }
                }

                Ok(AuditEntry {
                    id,
                    timestamp,
                    event,
                    tool_name,
                    status,
                    policy_match,
                    payload,
                    agent_id,
                    namespace,
                    anomaly_score,
                    nearest_neighbor,
                    fusion,
                })
            })
            .map_err(|e| anyhow!("Failed to execute query: {}", e))?;

        let mut result = Vec::new();
        for entry in entries {
            result.push(entry?);
        }

        Ok(result)
    }

    pub fn stats(&self) -> Result<VaultStats> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow!("Lock poisoned: {}", e))?;
        let total: usize =
            conn.query_row("SELECT COUNT(*) FROM audit_logs", [], |r: &Row| r.get(0))?;
        let allowed: usize = conn.query_row(
            "SELECT COUNT(*) FROM audit_logs WHERE status = 'ALLOWED'",
            [],
            |r: &Row| r.get(0),
        )?;
        let denied: usize = conn.query_row(
            "SELECT COUNT(*) FROM audit_logs WHERE status = 'DENIED'",
            [],
            |r: &Row| r.get(0),
        )?;

        Ok(VaultStats {
            total,
            allowed,
            denied,
        })
    }

    pub fn count(&self) -> Result<usize> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow!("Lock poisoned: {}", e))?;
        let count: usize =
            conn.query_row("SELECT COUNT(*) FROM audit_logs", [], |r: &Row| r.get(0))?;
        Ok(count)
    }

    pub fn db_path(&self) -> &str {
        &self.db_path
    }

    /// Retrieve recent audit logs for a specific namespace
    pub fn get_recent_by_namespace(
        &self,
        namespace: &str,
        limit: usize,
    ) -> Result<Vec<AuditEntry>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow!("Lock poisoned: {}", e))?;

        let mut stmt = conn.prepare(
            "SELECT id, timestamp, event, tool_name, status, policy_match, payload, agent_id, namespace, anomaly_score, nearest_neighbor, fusion
             FROM audit_logs WHERE namespace = ?1 ORDER BY timestamp DESC LIMIT ?2"
        ).map_err(|e| anyhow!("Failed to prepare query: {}", e))?;

        let entries = stmt
            .query_map(params![namespace, limit], |row: &Row| {
                let id: String = row.get(0)?;
                let timestamp: String = row.get(1)?;
                let event: String = row.get(2)?;
                let tool_name: String = row.get(3)?;
                let status: String = row.get(4)?;
                let policy_match: Option<String> = row.get(5)?;
                let mut payload: Option<String> = row.get(6)?;
                let agent_id: Option<String> = row.get(7)?;
                let namespace: Option<String> = row.get(8)?;
                let anomaly_score: Option<f32> = row.get(9)?;
                let nearest_neighbor: Option<String> = row.get(10)?;
                let fusion: Option<String> = row.get(11)?;
                let fusion: Option<FusionEvidence> =
                    fusion.and_then(|s| serde_json::from_str(&s).ok());

                // Decrypt payload if key is available
                if let (Some(key_bytes), Some(p_enc)) = (&self.encryption_key, &payload) {
                    if let Some(s) = decrypt_payload(key_bytes, &id, namespace.as_deref(), p_enc) {
                        payload = Some(s);
                    }
                }

                Ok(AuditEntry {
                    id,
                    timestamp,
                    event,
                    tool_name,
                    status,
                    policy_match,
                    payload,
                    agent_id,
                    namespace,
                    anomaly_score,
                    nearest_neighbor,
                    fusion,
                })
            })
            .map_err(|e| anyhow!("Failed to execute query: {}", e))?;

        let mut result = Vec::new();
        for entry in entries {
            result.push(entry?);
        }

        Ok(result)
    }

    /// Retrieve stats for a specific namespace
    pub fn stats_by_namespace(&self, namespace: &str) -> Result<VaultStats> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow!("Lock poisoned: {}", e))?;
        let total: usize = conn.query_row(
            "SELECT COUNT(*) FROM audit_logs WHERE namespace = ?1",
            [namespace],
            |r: &Row| r.get(0),
        )?;
        let allowed: usize = conn.query_row(
            "SELECT COUNT(*) FROM audit_logs WHERE status = 'ALLOWED' AND namespace = ?1",
            [namespace],
            |r: &Row| r.get(0),
        )?;
        let denied: usize = conn.query_row(
            "SELECT COUNT(*) FROM audit_logs WHERE status = 'DENIED' AND namespace = ?1",
            [namespace],
            |r: &Row| r.get(0),
        )?;

        Ok(VaultStats {
            total,
            allowed,
            denied,
        })
    }

    /// Access the underlying database connection
    pub fn get_connection(&self) -> Arc<Mutex<Connection>> {
        Arc::clone(&self.conn)
    }
}

/// Length in bytes of an AES-GCM nonce.
const NONCE_LEN: usize = 12;

/// Draw a fresh 12-byte nonce from the cryptographically secure,
/// OS-seeded random generator (`rand::rng()`).
fn random_nonce_bytes() -> [u8; NONCE_LEN] {
    use rand::Rng;
    let mut nonce = [0u8; NONCE_LEN];
    rand::rng().fill_bytes(&mut nonce);
    nonce
}

/// Build a nonce from stored bytes. Returns `None` when the length is not 12
/// instead of panicking.
fn nonce_from_bytes(bytes: &[u8]) -> Option<aes_gcm::aead::Nonce<Aes256Gcm>> {
    <[u8; NONCE_LEN]>::try_from(bytes).ok().map(Nonce::from)
}

/// Prefix of the current record format.
const V2_PREFIX: &str = "v2:";

/// Fixed label mixed into the additional authenticated data of v2 records.
const AAD_NAMESPACE: &str = "zn-audit-v2";

/// Additional authenticated data of a v2 record: a fixed label, then the
/// row id and the namespace, each with a presence flag and a length prefix
/// so that no two (id, namespace) pairs give the same bytes.
fn record_aad(record_id: &str, namespace: Option<&str>) -> Vec<u8> {
    let mut aad = AAD_NAMESPACE.as_bytes().to_vec();
    for field in [Some(record_id), namespace] {
        match field {
            Some(f) => {
                aad.push(1);
                aad.extend_from_slice(&(f.len() as u64).to_be_bytes());
                aad.extend_from_slice(f.as_bytes());
            }
            None => aad.push(0),
        }
    }
    aad
}

/// Encrypt a payload as `v2:base64(nonce):base64(ciphertext)`. The record id
/// and namespace are authenticated together with the ciphertext, so the record
/// only decrypts for the row and namespace it was written for.
fn encrypt_payload(
    key_bytes: &[u8; 32],
    record_id: &str,
    namespace: Option<&str>,
    plaintext: &str,
) -> Result<String> {
    let cipher = Aes256Gcm::new(key_bytes.into());
    let nonce_bytes = random_nonce_bytes();
    let nonce = Nonce::from(nonce_bytes);
    let aad = record_aad(record_id, namespace);
    let encrypted = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext.as_bytes(),
                aad: &aad,
            },
        )
        .map_err(|_| anyhow!("Payload encryption failed"))?;
    Ok(format!(
        "{}{}:{}",
        V2_PREFIX,
        general_purpose::STANDARD.encode(nonce_bytes),
        general_purpose::STANDARD.encode(&encrypted)
    ))
}

/// Decrypt `base64(nonce):base64(ciphertext)` with the given additional
/// authenticated data. Returns `None` for anything malformed, including a
/// nonce that is not 12 bytes long.
fn decrypt_body(key_bytes: &[u8; 32], body: &str, aad: &[u8]) -> Option<String> {
    let parts: Vec<&str> = body.split(':').collect();
    if parts.len() != 2 {
        return None;
    }
    let nonce_bytes = general_purpose::STANDARD.decode(parts[0]).ok()?;
    let ciphertext = general_purpose::STANDARD.decode(parts[1]).ok()?;
    let nonce = nonce_from_bytes(&nonce_bytes)?;
    let cipher = Aes256Gcm::new(key_bytes.into());
    let decrypted = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: ciphertext.as_slice(),
                aad,
            },
        )
        .ok()?;
    String::from_utf8(decrypted).ok()
}

/// Decrypt a stored payload. Only `v2:` records are accepted, and only for the
/// id and namespace of the row they were written for. Records in the old
/// format (no prefix, no authenticated id) are refused: they are upgraded once
/// by `migrate_v1_records` when the vault opens. Returns `None` for anything
/// else, malformed records included.
fn decrypt_payload(
    key_bytes: &[u8; 32],
    record_id: &str,
    namespace: Option<&str>,
    stored: &str,
) -> Option<String> {
    let body = stored.strip_prefix(V2_PREFIX)?;
    decrypt_body(key_bytes, body, &record_aad(record_id, namespace))
}

/// Decrypt a record in the old format (`base64(nonce):base64(ciphertext)`, no
/// additional authenticated data). Used only by the one-time upgrade.
fn decrypt_legacy_payload(key_bytes: &[u8; 32], stored: &str) -> Option<String> {
    if stored.starts_with(V2_PREFIX) {
        return None;
    }
    decrypt_body(key_bytes, stored, &[])
}

/// True when any bound (`v2:`) row opens with `key_bytes`. Rows that do not
/// decrypt (for instance a planted `v2:garbage` row) are skipped, so they
/// cannot hold the check open. The scan stops at the first row that opens, so
/// a healthy database needs one row; it reads them all only when none opens
/// (wrong passphrase or a hostile database). There is no row limit on purpose:
/// a limit would let enough garbage rows lock out the right passphrase.
fn existing_v2_record_decrypts(conn: &Connection, key_bytes: &[u8; 32]) -> Result<bool> {
    let mut stmt = conn.prepare(
        "SELECT id, namespace, payload FROM audit_logs
         WHERE substr(payload, 1, 3) = 'v2:'",
    )?;
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        let id: String = r.get(0)?;
        let namespace: Option<String> = r.get(1)?;
        let payload: String = r.get(2)?;
        if decrypt_payload(key_bytes, &id, namespace.as_deref(), &payload).is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Metadata entry that proves which passphrase a database was created with.
///
/// Construction: AES-256-GCM (the cipher that already protects the records)
/// of a fixed constant, with a fresh random nonce and its own additional
/// authenticated data, stored as `base64(nonce):base64(ciphertext)`. GCM
/// rejects any other key, so a successful decryption is proof that the key
/// matches. This adds no new primitive. The distinct AAD means the value can
/// never be mistaken for, or replayed as, a record (record AAD starts with
/// `zn-audit-v2`). Guessing a passphrase from it costs the same Argon2id work
/// as guessing it from any record, so it gives an attacker nothing extra.
const KEY_CHECK_KEY: &str = "key_check";
const KEY_CHECK_AAD: &[u8] = b"zn-audit-keycheck";
const KEY_CHECK_PLAINTEXT: &str = "zn-audit-key-check";

fn make_key_check(key_bytes: &[u8; 32]) -> Result<String> {
    let cipher = Aes256Gcm::new(key_bytes.into());
    let nonce_bytes = random_nonce_bytes();
    let encrypted = cipher
        .encrypt(
            &Nonce::from(nonce_bytes),
            Payload {
                msg: KEY_CHECK_PLAINTEXT.as_bytes(),
                aad: KEY_CHECK_AAD,
            },
        )
        .map_err(|_| anyhow!("Key check encryption failed"))?;
    Ok(format!(
        "{}:{}",
        general_purpose::STANDARD.encode(nonce_bytes),
        general_purpose::STANDARD.encode(&encrypted)
    ))
}

fn key_check_matches(key_bytes: &[u8; 32], stored: &str) -> bool {
    decrypt_body(key_bytes, stored, KEY_CHECK_AAD).as_deref() == Some(KEY_CHECK_PLAINTEXT)
}

fn read_key_check(conn: &Connection) -> Option<String> {
    conn.query_row(
        "SELECT value FROM metadata WHERE key = ?1",
        [KEY_CHECK_KEY],
        |r| r.get(0),
    )
    .ok()
}

/// Refuse a key that does not match the stored key check. Returns whether a
/// key check exists. A damaged value cannot be told apart from a wrong key, so
/// it is refused too, with a message that names both.
fn verify_key_check(conn: &Connection, key_bytes: &[u8; 32]) -> Result<bool> {
    match read_key_check(conn) {
        None => Ok(false),
        Some(stored) if key_check_matches(key_bytes, &stored) => Ok(true),
        Some(_) => Err(anyhow!(
            "Audit database cannot be opened: wrong passphrase (or the stored key check is damaged). No audit records were changed."
        )),
    }
}

/// Without a key check, a database that holds bound records must open at
/// least one of them with this key; otherwise the passphrase is wrong.
fn refuse_if_no_bound_record_opens(conn: &Connection, key_bytes: &[u8; 32]) -> Result<()> {
    let has_bound_rows: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM audit_logs WHERE substr(payload, 1, 3) = 'v2:')",
        [],
        |r| r.get(0),
    )?;
    if has_bound_rows && !existing_v2_record_decrypts(conn, key_bytes)? {
        return Err(anyhow!(
            "Audit database cannot be opened: wrong passphrase (no stored record opens with it). No audit records were changed."
        ));
    }
    Ok(())
}

/// Write the key check when the database has none and the key is known to be
/// the right one: the database holds nothing encrypted yet, or a bound record
/// already decrypts with this key. If encrypted rows exist and none can be
/// verified, nothing is written (same caution as the upgrade marker): it could
/// be a wrong passphrase, and the right one must still be able to verify later.
/// A database with no encrypted rows at all (empty, or only plain text) has
/// nothing the key could contradict, so the first passphrase used becomes the
/// key, like the salt.
fn write_key_check_if_verified(
    conn: &Connection,
    key_bytes: &[u8; 32],
    unreadable_old_records: usize,
) -> Result<()> {
    let has_bound_rows: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM audit_logs WHERE substr(payload, 1, 3) = 'v2:')",
        [],
        |r| r.get(0),
    )?;
    let verified = if has_bound_rows {
        existing_v2_record_decrypts(conn, key_bytes)?
    } else {
        unreadable_old_records == 0
    };
    if verified {
        conn.execute(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES (?1, ?2)",
            params![KEY_CHECK_KEY, make_key_check(key_bytes)?],
        )?;
    }
    Ok(())
}

/// Metadata key and value that mark a database whose records are all in the
/// bound format.
const FORMAT_KEY: &str = "audit_format";
const FORMAT_V2: &str = "v2";

/// Outcome of the upgrade of old-format records.
#[derive(Debug, Default, PartialEq, Eq)]
struct MigrationReport {
    /// Records rewritten in the bound format.
    migrated: usize,
    /// Records in the old shape that did not decrypt with this key.
    unreadable: usize,
    /// Rows that are not in the old shape at all (plain text stored before
    /// encryption was enabled). Left as they are.
    not_encrypted: usize,
}

/// True when `stored` has the shape of an old-format record: base64 of a
/// 12-byte nonce, ':', base64 of at least a 16-byte tag.
fn is_legacy_shaped(stored: &str) -> bool {
    let mut parts = stored.split(':');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(n), Some(c), None) => {
            matches!(general_purpose::STANDARD.decode(n), Ok(v) if v.len() == NONCE_LEN)
                && matches!(general_purpose::STANDARD.decode(c), Ok(v) if v.len() >= 16)
        }
        _ => false,
    }
}

/// Rewrite every old-format record as a `v2:` record bound to its own id and
/// namespace, in one transaction, and then store `audit_format=v2` in the
/// metadata table.
///
/// - A database already marked `v2` is left alone (the marker is the only
///   trigger: record timestamps and contents are writable and prove nothing).
/// - If the process stops half way, the transaction rolls back and the next
///   open starts again.
/// - Rows that do not decrypt with this key are never deleted or changed.
///   Rows that are not in the old shape (plain text from before encryption
///   was on) are only counted. Old-shaped rows that fail (wrong passphrase or
///   corruption) block the marker unless the key is proven right, that is, it
///   opened an old record in this run or opens an existing bound record. So a
///   wrong passphrase sets no marker and the right one can still upgrade
///   later, while a right key closes the upgrade even if a corrupted row
///   remains, and an old record planted afterwards is never rewritten as a
///   valid bound one. The open vault never accepts the old format either way.
fn migrate_v1_records(
    conn: &mut Connection,
    key_bytes: &[u8; 32],
    key_proven: bool,
) -> Result<MigrationReport> {
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| anyhow!("Failed to start audit upgrade: {}", e))?;
    let marked: Option<String> = tx
        .query_row(
            "SELECT value FROM metadata WHERE key = ?1",
            [FORMAT_KEY],
            |r| r.get(0),
        )
        .ok();
    if marked.as_deref() == Some(FORMAT_V2) {
        return Ok(MigrationReport::default());
    }

    let rows: Vec<(String, Option<String>, String)> = {
        let mut stmt = tx.prepare(
            "SELECT id, namespace, payload FROM audit_logs
             WHERE payload IS NOT NULL AND substr(payload, 1, 3) != 'v2:'",
        )?;
        let mapped = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        mapped.collect::<std::result::Result<_, _>>()?
    };

    let mut report = MigrationReport::default();
    for (id, namespace, stored) in rows {
        match decrypt_legacy_payload(key_bytes, &stored) {
            Some(plain) => {
                let upgraded = encrypt_payload(key_bytes, &id, namespace.as_deref(), &plain)?;
                tx.execute(
                    "UPDATE audit_logs SET payload = ?1 WHERE id = ?2",
                    params![upgraded, id],
                )?;
                report.migrated += 1;
            }
            None => {
                if is_legacy_shaped(&stored) {
                    report.unreadable += 1;
                } else {
                    report.not_encrypted += 1;
                }
            }
        }
    }
    // The key is proven right if it opened an old record in this run or opens
    // an existing bound record. Then the marker is safe to set even if some
    // old-shaped rows stay unreadable (corrupted): they are left as they are.
    let v2_ok = key_proven || report.migrated > 0 || existing_v2_record_decrypts(&tx, key_bytes)?;
    if report.unreadable == 0 || v2_ok {
        tx.execute(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES (?1, ?2)",
            params![FORMAT_KEY, FORMAT_V2],
        )?;
    }
    tx.commit()
        .map_err(|e| anyhow!("Failed to commit audit upgrade: {}", e))?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_db_path() -> String {
        format!("test_audit_{}.db", Uuid::new_v4())
    }

    #[test]
    fn test_audit_vault_creation() {
        let path = temp_db_path();
        let vault = AuditVault::new(&path, None).expect("Failed to create vault");
        assert_eq!(vault.count().unwrap(), 0);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn test_audit_entry_builder() {
        let entry = AuditEntry::new("TOOL_CALL", "read_file", "ALLOWED")
            .with_policy("base_security")
            .with_payload("{\"path\": \"/tmp/test\"}")
            .with_agent_id("agent-123");

        assert_eq!(entry.event, "TOOL_CALL");
        assert_eq!(entry.tool_name, "read_file");
        assert_eq!(entry.status, "ALLOWED");
        assert_eq!(entry.policy_match, Some("base_security".to_string()));
        assert!(entry.payload.is_some());
        assert_eq!(entry.agent_id, Some("agent-123".to_string()));
        assert!(entry.nearest_neighbor.is_none());
    }

    /// B-3: the fusion object must appear in serialized records ONLY when
    /// fusion actively participated (cameras/score/tau absent otherwise).
    #[test]
    fn fusion_evidence_serialized_only_when_fusion_active() {
        let plain =
            AuditEntry::new("TOOL_CALL", "bash", "DENIED").with_policy("restricted_commands");
        let plain_json = serde_json::to_string(&plain).unwrap();
        assert!(
            !plain_json.contains("fusion")
                && !plain_json.contains("cameras")
                && !plain_json.contains("neural_score")
                && !plain_json.contains("\"tau\""),
            "inactive fusion must not leak fields: {plain_json}"
        );

        let fused = AuditEntry::new("TOOL_CALL", "bash", "DENIED").with_fusion(FusionEvidence {
            cameras: vec!["rules".into(), "neural".into()],
            neural_score: 0.91,
            tau: 0.5,
            model_id: "zn-minilm-l6-v2-sec-1787490939".into(),
        });
        let fused_json = serde_json::to_string(&fused).unwrap();
        assert!(fused_json.contains(r#""cameras":["rules","neural"]"#));
        assert!(fused_json.contains(r#""neural_score":0.91"#));
        assert!(fused_json.contains(r#""tau":0.5"#));
        assert!(fused_json.contains("zn-minilm-l6-v2-sec-1787490939"));
    }

    /// B-3: fusion evidence survives the audit vault round-trip.
    #[test]
    fn fusion_evidence_persists_through_audit_vault() {
        let path = temp_db_path();
        let vault = AuditVault::new(&path, None).expect("Failed to create vault");
        vault
            .log(
                AuditEntry::new("TOOL_CALL", "bash", "DENIED").with_fusion(FusionEvidence {
                    cameras: vec!["neural".into()],
                    neural_score: 0.73,
                    tau: 0.5,
                    model_id: "m1".into(),
                }),
            )
            .expect("log fused entry");
        let recent = vault.get_recent(10).expect("get recent");
        let ev = recent[0].fusion.as_ref().expect("evidence round-tripped");
        assert_eq!(ev.cameras, vec!["neural".to_string()]);
        assert!((ev.neural_score - 0.73).abs() < 1e-6);
        assert_eq!(ev.tau, 0.5);
        // And an unfused entry stays unfused.
        vault
            .log(AuditEntry::new("TOOL_CALL", "ls", "ALLOWED"))
            .unwrap();
        let recent = vault.get_recent(10).unwrap();
        assert!(recent
            .iter()
            .find(|e| e.tool_name == "ls")
            .unwrap()
            .fusion
            .is_none());
        fs::remove_file(&path).ok();
    }

    #[test]
    fn test_log_and_retrieve() {
        let path = temp_db_path();
        let vault = AuditVault::new(&path, None).expect("Failed to create vault");

        let entry = AuditEntry::new("TOOL_CALL", "delete_file", "DENIED");
        vault.log(entry).expect("Failed to log entry");

        assert_eq!(vault.count().unwrap(), 1);

        let recent = vault.get_recent(10).expect("Failed to get recent");
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].tool_name, "delete_file");
        assert_eq!(recent[0].status, "DENIED");

        fs::remove_file(&path).ok();
    }

    #[test]
    fn test_stats() {
        let path = temp_db_path();
        let vault = AuditVault::new(&path, None).expect("Failed to create vault");

        // Log some entries
        vault
            .log(AuditEntry::new("TOOL_CALL", "read_file", "ALLOWED"))
            .unwrap();
        vault
            .log(AuditEntry::new("TOOL_CALL", "write_file", "ALLOWED"))
            .unwrap();
        vault
            .log(AuditEntry::new("TOOL_CALL", "delete_file", "DENIED"))
            .unwrap();

        let stats = vault.stats().expect("Failed to get stats");
        assert_eq!(stats.total, 3);
        assert_eq!(stats.allowed, 2);
        assert_eq!(stats.denied, 1);

        fs::remove_file(&path).ok();
    }

    #[test]
    fn test_namespace_isolation() {
        let path = temp_db_path();
        let vault = AuditVault::new(&path, None).expect("Failed to create vault");

        // Log entries with different namespaces
        let mut entry1 = AuditEntry::new("TOOL_CALL", "read_file", "ALLOWED");
        entry1.namespace = Some("tenant_a".to_string());
        vault.log(entry1).unwrap();

        let mut entry2 = AuditEntry::new("TOOL_CALL", "write_file", "DENIED");
        entry2.namespace = Some("tenant_b".to_string());
        vault.log(entry2).unwrap();

        let tenant_a_logs = vault.get_recent_by_namespace("tenant_a", 10).unwrap();
        assert_eq!(tenant_a_logs.len(), 1);
        assert_eq!(tenant_a_logs[0].tool_name, "read_file");

        let tenant_b_stats = vault.stats_by_namespace("tenant_b").unwrap();
        assert_eq!(tenant_b_stats.total, 1);
        assert_eq!(tenant_b_stats.denied, 1);

        fs::remove_file(&path).ok();
    }

    #[test]
    fn test_encryption_key_derivation() {
        let path = temp_db_path();
        // Use a simple passphrase for testing
        let vault = AuditVault::new(&path, Some("test_encryption_key"))
            .expect("Failed to create vault with encryption");

        // Log an entry with payload
        let entry = AuditEntry::new("TOOL_CALL", "secret_op", "ALLOWED")
            .with_payload("{\"secret\": \"hidden\"}");
        vault.log(entry).expect("Failed to log encrypted entry");

        // Retrieve and verify (payload should be decrypted)
        let recent = vault.get_recent(1).expect("Failed to get recent");
        assert_eq!(recent.len(), 1);
        assert!(recent[0].payload.is_some());
        assert!(recent[0].payload.as_ref().unwrap().contains("secret"));

        fs::remove_file(&path).ok();
    }

    const TEST_KEY: [u8; 32] = [7u8; 32];
    const ID_A: &str = "3f2b8c1e-0000-4000-8000-000000000001";
    const ID_B: &str = "3f2b8c1e-0000-4000-8000-000000000002";

    #[test]
    fn nonces_differ_between_encryptions_and_are_12_bytes() {
        let a = encrypt_payload(&TEST_KEY, ID_A, None, "same plaintext").unwrap();
        let b = encrypt_payload(&TEST_KEY, ID_A, None, "same plaintext").unwrap();
        let nonce_a = general_purpose::STANDARD
            .decode(a.split(':').nth(1).unwrap())
            .unwrap();
        let nonce_b = general_purpose::STANDARD
            .decode(b.split(':').nth(1).unwrap())
            .unwrap();
        assert_eq!(nonce_a.len(), 12);
        assert_eq!(nonce_b.len(), 12);
        assert_ne!(nonce_a, nonce_b);
        assert_ne!(a, b);
    }

    #[test]
    fn encrypt_decrypt_round_trip() {
        let plain = r#"{"path": "/example/test"}"#;
        let stored = encrypt_payload(&TEST_KEY, ID_A, None, plain).unwrap();
        assert_eq!(
            decrypt_payload(&TEST_KEY, ID_A, None, &stored).as_deref(),
            Some(plain)
        );
        assert_eq!(decrypt_payload(&[8u8; 32], ID_A, None, &stored), None);
    }

    #[test]
    fn wrong_length_nonce_is_rejected_without_panic() {
        let stored = encrypt_payload(&TEST_KEY, ID_A, None, "payload").unwrap();
        let ciphertext = stored.split(':').nth(2).unwrap();
        for len in [0usize, 11, 13, 16, 32] {
            let bad_nonce = general_purpose::STANDARD.encode(vec![1u8; len]);
            let record = format!("v2:{bad_nonce}:{ciphertext}");
            assert_eq!(
                decrypt_payload(&TEST_KEY, ID_A, None, &record),
                None,
                "len {len}"
            );
        }
        assert!(nonce_from_bytes(&[0u8; 11]).is_none());
        assert!(nonce_from_bytes(&[0u8; 12]).is_some());
    }

    #[test]
    fn record_with_uuid_derived_nonce_still_decrypts() {
        // Written by the previous implementation: nonce = first 12 bytes of
        // UUID f47ac10b-58cc-4372-a567-0e02b2c3d479, key = bytes 0..32.
        let key: [u8; 32] = core::array::from_fn(|i| i as u8);
        let stored = "9HrBC1jMQ3KlZw4C:L/y1YqQCZUTXTgxQwtxWpwR43HyLXNyF9bCDJUsoYcmfaX8+qmP4L4M=";
        assert_eq!(
            decrypt_legacy_payload(&key, stored).as_deref(),
            Some(r#"{"path": "/example/test"}"#)
        );
    }

    #[test]
    fn new_records_use_the_v2_format() {
        let stored = encrypt_payload(&TEST_KEY, ID_A, None, "payload").unwrap();
        assert!(stored.starts_with("v2:"));
        assert_eq!(stored.split(':').count(), 3);
    }

    #[test]
    fn v2_record_does_not_decrypt_for_another_row() {
        let stored = encrypt_payload(&TEST_KEY, ID_A, None, "payload").unwrap();
        assert_eq!(
            decrypt_payload(&TEST_KEY, ID_A, None, &stored).as_deref(),
            Some("payload")
        );
        assert_eq!(decrypt_payload(&TEST_KEY, ID_B, None, &stored), None);
    }

    #[test]
    fn v2_payload_moved_between_rows_is_not_readable() {
        let path = temp_db_path();
        let vault = AuditVault::new(&path, Some("test-passphrase")).expect("vault");
        let mut first = AuditEntry::new("event_a", "tool", "ALLOWED");
        first.payload = Some("first secret".to_string());
        let mut second = AuditEntry::new("event_b", "tool", "ALLOWED");
        second.payload = Some("second secret".to_string());
        let (first_id, second_id) = (first.id.clone(), second.id.clone());
        vault.log(first).unwrap();
        vault.log(second).unwrap();
        {
            let conn = vault.get_connection();
            let conn = conn.lock().unwrap();
            conn.execute(
                "UPDATE audit_logs SET payload = (SELECT payload FROM audit_logs WHERE id = ?1) WHERE id = ?2",
                params![first_id, second_id],
            )
            .unwrap();
        }
        let rows = vault.get_recent(10).unwrap();
        let moved = rows.iter().find(|r| r.id == second_id).unwrap();
        // Not decrypted: the stored text comes back as it is.
        assert!(moved.payload.as_deref().unwrap().starts_with("v2:"));
        let original = rows.iter().find(|r| r.id == first_id).unwrap();
        assert_eq!(original.payload.as_deref(), Some("first secret"));
        fs::remove_file(&path).ok();
    }

    const LEGACY_KEY_PASSPHRASE: &str = "test-passphrase";

    /// Derive the vault key the same way `AuditVault::new` does.
    fn vault_key(path: &str, passphrase: &str) -> [u8; 32] {
        let conn = Connection::open(path).unwrap();
        let salt_hex: String = conn
            .query_row(
                "SELECT value FROM metadata WHERE key = 'derivation_salt'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let salt = hex::decode(salt_hex).unwrap();
        derive_key(passphrase, &salt).unwrap()
    }

    /// Old-format record: random nonce, no additional authenticated data.
    fn legacy_record(key: &[u8; 32], plaintext: &str) -> String {
        let cipher = Aes256Gcm::new(key.into());
        let nonce_bytes = random_nonce_bytes();
        let encrypted = cipher
            .encrypt(&Nonce::from(nonce_bytes), plaintext.as_bytes())
            .unwrap();
        format!(
            "{}:{}",
            general_purpose::STANDARD.encode(nonce_bytes),
            general_purpose::STANDARD.encode(encrypted)
        )
    }

    fn set_payload(path: &str, id: &str, payload: &str) {
        let conn = Connection::open(path).unwrap();
        conn.execute(
            "UPDATE audit_logs SET payload = ?1 WHERE id = ?2",
            params![payload, id],
        )
        .unwrap();
    }

    fn raw_payload(path: &str, id: &str) -> String {
        let conn = Connection::open(path).unwrap();
        conn.query_row("SELECT payload FROM audit_logs WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .unwrap()
    }

    fn format_marker(path: &str) -> Option<String> {
        let conn = Connection::open(path).unwrap();
        conn.query_row(
            "SELECT value FROM metadata WHERE key = 'audit_format'",
            [],
            |r| r.get(0),
        )
        .ok()
    }

    /// Build a database with `n` entries logged through a keyed vault, then
    /// turn their payloads into old-format records. Returns id, namespace and
    /// plaintext of each.
    fn legacy_db(path: &str, n: usize) -> Vec<(String, Option<String>, String)> {
        let vault = AuditVault::new(path, Some(LEGACY_KEY_PASSPHRASE)).expect("vault");
        let mut out = Vec::new();
        for i in 0..n {
            let mut e = AuditEntry::new("event", "tool", "ALLOWED");
            e.payload = Some(format!("secret {i}"));
            if i % 2 == 0 {
                e.namespace = Some(format!("tenant_{i}"));
            }
            out.push((e.id.clone(), e.namespace.clone(), format!("secret {i}")));
            vault.log(e).unwrap();
        }
        drop(vault);
        let key = vault_key(path, LEGACY_KEY_PASSPHRASE);
        for (id, _, plain) in &out {
            set_payload(path, id, &legacy_record(&key, plain));
        }
        // Back to the state of a database written before the upgrade existed.
        let conn = Connection::open(path).unwrap();
        conn.execute("DELETE FROM metadata WHERE key = 'audit_format'", [])
            .unwrap();
        conn.execute("DELETE FROM metadata WHERE key = 'key_check'", [])
            .unwrap();
        out
    }

    #[test]
    fn decrypt_payload_refuses_the_old_format() {
        let key: [u8; 32] = core::array::from_fn(|i| i as u8);
        let stored = "9HrBC1jMQ3KlZw4C:L/y1YqQCZUTXTgxQwtxWpwR43HyLXNyF9bCDJUsoYcmfaX8+qmP4L4M=";
        for id in [ID_A, ID_B, ""] {
            assert_eq!(decrypt_payload(&key, id, None, stored), None);
        }
        assert_eq!(
            decrypt_legacy_payload(&key, stored).as_deref(),
            Some(r#"{"path": "/example/test"}"#)
        );
    }

    #[test]
    fn migration_rewrites_old_records_and_they_read_back() {
        let path = temp_db_path();
        let rows = legacy_db(&path, 4);
        for (id, _, _) in &rows {
            assert!(!raw_payload(&path, id).starts_with("v2:"));
        }
        let vault = AuditVault::new(&path, Some(LEGACY_KEY_PASSPHRASE)).expect("vault");
        for (id, _, _) in &rows {
            assert!(raw_payload(&path, id).starts_with("v2:"));
        }
        assert_eq!(format_marker(&path).as_deref(), Some("v2"));
        let read = vault.get_recent(10).unwrap();
        assert_eq!(read.len(), 4);
        for (id, ns, plain) in &rows {
            let r = read.iter().find(|r| &r.id == id).unwrap();
            assert_eq!(r.payload.as_deref(), Some(plain.as_str()));
            assert_eq!(&r.namespace, ns);
        }
        drop(vault);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn old_record_inserted_after_migration_is_refused() {
        let path = temp_db_path();
        let rows = legacy_db(&path, 1);
        drop(AuditVault::new(&path, Some(LEGACY_KEY_PASSPHRASE)).unwrap());
        let key = vault_key(&path, LEGACY_KEY_PASSPHRASE);
        let (id, _, _) = &rows[0];
        let old = legacy_record(&key, "planted");
        set_payload(&path, id, &old);
        // A fresh open does not read it and does not rewrite it.
        let vault = AuditVault::new(&path, Some(LEGACY_KEY_PASSPHRASE)).unwrap();
        assert_eq!(raw_payload(&path, id), old);
        let read = vault.get_recent(10).unwrap();
        assert_eq!(read[0].payload.as_deref(), Some(old.as_str()));
        drop(vault);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn migration_is_idempotent() {
        let path = temp_db_path();
        let rows = legacy_db(&path, 3);
        drop(AuditVault::new(&path, Some(LEGACY_KEY_PASSPHRASE)).unwrap());
        let after_first: Vec<String> = rows
            .iter()
            .map(|(id, _, _)| raw_payload(&path, id))
            .collect();
        let vault = AuditVault::new(&path, Some(LEGACY_KEY_PASSPHRASE)).unwrap();
        let after_second: Vec<String> = rows
            .iter()
            .map(|(id, _, _)| raw_payload(&path, id))
            .collect();
        assert_eq!(after_first, after_second);
        assert_eq!(vault.count().unwrap(), 3);
        drop(vault);
        // A direct call on a marked database does nothing.
        let key = vault_key(&path, LEGACY_KEY_PASSPHRASE);
        let mut conn = Connection::open(&path).unwrap();
        assert_eq!(
            migrate_v1_records(&mut conn, &key, false).unwrap(),
            MigrationReport::default()
        );
        fs::remove_file(&path).ok();
    }

    #[test]
    fn migration_with_an_unreadable_record_upgrades_the_rest() {
        const BAD: &str = "AAAAAAAAAAAAAAAA:bm90IGEgcmVhbCBjaXBoZXJ0ZXh0";
        let path = temp_db_path();
        let rows = legacy_db(&path, 3);
        let corrupted_id = rows[1].0.clone();
        set_payload(&path, &corrupted_id, BAD);
        let vault = AuditVault::new(&path, Some(LEGACY_KEY_PASSPHRASE)).unwrap();
        // The unreadable row is untouched, the others are upgraded.
        assert_eq!(raw_payload(&path, &corrupted_id), BAD);
        let read = vault.get_recent(10).unwrap();
        for (id, _, plain) in &rows {
            let r = read.iter().find(|r| &r.id == id).unwrap();
            if id == &corrupted_id {
                assert_ne!(r.payload.as_deref(), Some(plain.as_str()));
            } else {
                assert_eq!(r.payload.as_deref(), Some(plain.as_str()));
                assert!(raw_payload(&path, id).starts_with("v2:"));
            }
        }
        // The key is proven right by the rows that migrated, so the marker is set.
        assert_eq!(format_marker(&path).as_deref(), Some("v2"));
        drop(vault);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn plain_text_rows_do_not_block_the_marker() {
        let path = temp_db_path();
        let rows = legacy_db(&path, 3);
        set_payload(&path, &rows[1].0, "stored before encryption was on");
        let vault = AuditVault::new(&path, Some(LEGACY_KEY_PASSPHRASE)).unwrap();
        assert_eq!(format_marker(&path).as_deref(), Some("v2"));
        assert_eq!(
            raw_payload(&path, &rows[1].0),
            "stored before encryption was on"
        );
        assert!(raw_payload(&path, &rows[0].0).starts_with("v2:"));
        drop(vault);
        // Only plain text rows and no old records: nothing proves the key, but
        // nothing is unreadable either, so the marker is set.
        let path2 = temp_db_path();
        let rows2 = legacy_db(&path2, 1);
        set_payload(&path2, &rows2[0].0, "plain");
        drop(AuditVault::new(&path2, Some(LEGACY_KEY_PASSPHRASE)).unwrap());
        assert_eq!(format_marker(&path2).as_deref(), Some("v2"));
        fs::remove_file(&path).ok();
        fs::remove_file(&path2).ok();
    }

    #[test]
    fn old_record_planted_after_a_corrupted_row_is_not_rewritten() {
        const BAD: &str = "AAAAAAAAAAAAAAAA:bm90IGEgcmVhbCBjaXBoZXJ0ZXh0";
        let path = temp_db_path();
        let rows = legacy_db(&path, 3);
        set_payload(&path, &rows[1].0, BAD);
        drop(AuditVault::new(&path, Some(LEGACY_KEY_PASSPHRASE)).unwrap());
        assert_eq!(format_marker(&path).as_deref(), Some("v2"));
        assert_eq!(raw_payload(&path, &rows[1].0), BAD);
        // Plant a valid old record (as if copied from an old backup).
        let key = vault_key(&path, LEGACY_KEY_PASSPHRASE);
        let planted = legacy_record(&key, "planted");
        set_payload(&path, &rows[2].0, &planted);
        let vault = AuditVault::new(&path, Some(LEGACY_KEY_PASSPHRASE)).unwrap();
        assert_eq!(raw_payload(&path, &rows[2].0), planted);
        let read = vault.get_recent(10).unwrap();
        let r = read.iter().find(|r| r.id == rows[2].0).unwrap();
        assert_eq!(r.payload.as_deref(), Some(planted.as_str()));
        drop(vault);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn wrong_passphrase_does_not_lock_out_the_right_one() {
        let path = temp_db_path();
        let rows = legacy_db(&path, 2);
        drop(AuditVault::new(&path, Some("wrong-passphrase")).unwrap());
        assert_eq!(format_marker(&path), None);
        for (id, _, _) in &rows {
            assert!(!raw_payload(&path, id).starts_with("v2:"));
        }
        let vault = AuditVault::new(&path, Some(LEGACY_KEY_PASSPHRASE)).unwrap();
        let read = vault.get_recent(10).unwrap();
        for (id, _, plain) in &rows {
            let r = read.iter().find(|r| &r.id == id).unwrap();
            assert_eq!(r.payload.as_deref(), Some(plain.as_str()));
        }
        assert_eq!(format_marker(&path).as_deref(), Some("v2"));
        drop(vault);
        fs::remove_file(&path).ok();
    }

    fn key_check_value(path: &str) -> Option<String> {
        let conn = Connection::open(path).unwrap();
        read_key_check(&conn)
    }

    fn set_metadata(path: &str, key: &str, value: Option<&str>) {
        let conn = Connection::open(path).unwrap();
        match value {
            Some(v) => conn
                .execute(
                    "INSERT OR REPLACE INTO metadata (key, value) VALUES (?1, ?2)",
                    params![key, v],
                )
                .unwrap(),
            None => conn
                .execute("DELETE FROM metadata WHERE key = ?1", [key])
                .unwrap(),
        };
    }

    fn plant_garbage_v2_row(path: &str) {
        let conn = Connection::open(path).unwrap();
        conn.execute(
            "INSERT INTO audit_logs (id, timestamp, event, tool_name, status, payload)
             VALUES ('garbage-first', '2026-01-01T00:00:00Z', 'e', 't', 'ALLOWED', 'v2:garbage')",
            [],
        )
        .unwrap();
    }

    fn log_payload(vault: &AuditVault, payload: &str) {
        let mut e = AuditEntry::new("event", "tool", "ALLOWED");
        e.payload = Some(payload.into());
        vault.log(e).unwrap();
    }

    #[test]
    fn first_open_with_a_key_writes_the_key_check() {
        let path = temp_db_path();
        drop(AuditVault::new(&path, Some("right")).unwrap());
        let stored = key_check_value(&path).expect("key check written");
        assert!(key_check_matches(&vault_key(&path, "right"), &stored));
        drop(AuditVault::new(&path, Some("right")).unwrap());
        fs::remove_file(&path).ok();
    }

    #[test]
    fn no_key_means_no_key_check() {
        let path = temp_db_path();
        drop(AuditVault::new(&path, None).unwrap());
        assert_eq!(key_check_value(&path), None);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn wrong_passphrase_is_refused_once_a_key_check_exists() {
        let path = temp_db_path();
        let vault = AuditVault::new(&path, Some("right")).unwrap();
        log_payload(&vault, "secret");
        drop(vault);
        let err = AuditVault::new(&path, Some("wrong"))
            .err()
            .expect("wrong passphrase must be refused")
            .to_string();
        assert!(err.contains("wrong passphrase"), "{err}");
        // No record was changed by the refused open.
        let conn = Connection::open(&path).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM audit_logs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        drop(conn);
        let vault = AuditVault::new(&path, Some("right")).unwrap();
        assert_eq!(
            vault.get_recent(5).unwrap()[0].payload.as_deref(),
            Some("secret")
        );
        drop(vault);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn existing_database_gets_a_key_check_after_verification() {
        let path = temp_db_path();
        legacy_db(&path, 2);
        assert_eq!(key_check_value(&path), None);
        drop(AuditVault::new(&path, Some(LEGACY_KEY_PASSPHRASE)).unwrap());
        assert!(key_check_value(&path).is_some());
        // A bound database whose key check was removed gets it back.
        set_metadata(&path, KEY_CHECK_KEY, None);
        drop(AuditVault::new(&path, Some(LEGACY_KEY_PASSPHRASE)).unwrap());
        assert!(key_check_value(&path).is_some());
        fs::remove_file(&path).ok();
    }

    #[test]
    fn unverifiable_database_gets_no_key_check() {
        let path = temp_db_path();
        legacy_db(&path, 2);
        drop(AuditVault::new(&path, Some("wrong-passphrase")).unwrap());
        assert_eq!(key_check_value(&path), None);
        // The right passphrase still works and then writes it.
        drop(AuditVault::new(&path, Some(LEGACY_KEY_PASSPHRASE)).unwrap());
        assert!(key_check_value(&path).is_some());
        fs::remove_file(&path).ok();
    }

    #[test]
    fn corrupted_key_check_is_a_clear_error_not_a_panic() {
        for bad in ["", "not base64 at all", "AAAA:AAAA", "a:b:c"] {
            let path = temp_db_path();
            drop(AuditVault::new(&path, Some("right")).unwrap());
            set_metadata(&path, KEY_CHECK_KEY, Some(bad));
            let err = AuditVault::new(&path, Some("right"))
                .err()
                .expect("damaged key check must be refused")
                .to_string();
            assert!(err.contains("wrong passphrase"), "{err}");
            fs::remove_file(&path).ok();
        }
    }

    #[test]
    fn planted_garbage_row_does_not_block_key_verification() {
        let path = temp_db_path();
        drop(AuditVault::new(&path, Some("right")).unwrap());
        plant_garbage_v2_row(&path);
        let vault = AuditVault::new(&path, Some("right")).unwrap();
        log_payload(&vault, "real");
        drop(vault);
        set_metadata(&path, KEY_CHECK_KEY, None);
        let key = vault_key(&path, "right");
        let conn = Connection::open(&path).unwrap();
        assert!(existing_v2_record_decrypts(&conn, &key).unwrap());
        drop(conn);
        drop(AuditVault::new(&path, Some("right")).unwrap());
        assert!(key_check_value(&path).is_some());
        fs::remove_file(&path).ok();
    }

    #[test]
    fn planted_garbage_row_does_not_hold_the_upgrade_marker_open() {
        const BAD: &str = "AAAAAAAAAAAAAAAA:bm90IGEgcmVhbCBjaXBoZXJ0ZXh0";
        let path = temp_db_path();
        drop(AuditVault::new(&path, Some("right")).unwrap());
        plant_garbage_v2_row(&path);
        let vault = AuditVault::new(&path, Some("right")).unwrap();
        log_payload(&vault, "real");
        drop(vault);
        // Only an unreadable old record besides the good bound one.
        set_metadata(&path, FORMAT_KEY, None);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute(
                "INSERT INTO audit_logs (id, timestamp, event, tool_name, status, payload)
                 VALUES ('old-bad', '2026-01-01T00:00:00Z', 'e', 't', 'ALLOWED', ?1)",
                [BAD],
            )
            .unwrap();
        }
        drop(AuditVault::new(&path, Some("right")).unwrap());
        assert_eq!(format_marker(&path).as_deref(), Some("v2"));
        fs::remove_file(&path).ok();
    }

    #[test]
    fn wrong_passphrase_is_refused_when_the_key_check_is_missing() {
        let path = temp_db_path();
        let vault = AuditVault::new(&path, Some("right")).unwrap();
        log_payload(&vault, "secret");
        drop(vault);
        set_metadata(&path, KEY_CHECK_KEY, None);
        let err = AuditVault::new(&path, Some("wrong"))
            .err()
            .expect("wrong passphrase must be refused")
            .to_string();
        assert!(err.contains("wrong passphrase"), "{err}");
        let conn = Connection::open(&path).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM audit_logs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        drop(conn);
        assert_eq!(key_check_value(&path), None);
        let vault = AuditVault::new(&path, Some("right")).unwrap();
        assert_eq!(
            vault.get_recent(5).unwrap()[0].payload.as_deref(),
            Some("secret")
        );
        drop(vault);
        assert!(key_check_value(&path).is_some());
        fs::remove_file(&path).ok();
    }

    #[test]
    fn many_garbage_rows_do_not_lock_out_the_right_passphrase() {
        let path = temp_db_path();
        drop(AuditVault::new(&path, Some("right")).unwrap());
        {
            let conn = Connection::open(&path).unwrap();
            for i in 0..1001 {
                conn.execute(
                    "INSERT INTO audit_logs (id, timestamp, event, tool_name, status, payload)
                     VALUES (?1, '2026-01-01T00:00:00Z', 'e', 't', 'ALLOWED', 'v2:garbage')",
                    [format!("garbage-{i:05}")],
                )
                .unwrap();
            }
        }
        let vault = AuditVault::new(&path, Some("right")).unwrap();
        log_payload(&vault, "real");
        drop(vault);
        set_metadata(&path, KEY_CHECK_KEY, None);
        // The good record sits after 1001 garbage rows and still verifies.
        drop(AuditVault::new(&path, Some("right")).unwrap());
        assert!(key_check_value(&path).is_some());
        fs::remove_file(&path).ok();
    }

    #[test]
    fn valid_key_check_sets_the_marker_behind_many_garbage_rows() {
        const BAD: &str = "AAAAAAAAAAAAAAAA:bm90IGEgcmVhbCBjaXBoZXJ0ZXh0";
        let path = temp_db_path();
        drop(AuditVault::new(&path, Some("right")).unwrap());
        {
            let conn = Connection::open(&path).unwrap();
            for i in 0..1001 {
                conn.execute(
                    "INSERT INTO audit_logs (id, timestamp, event, tool_name, status, payload)
                     VALUES (?1, '2026-01-01T00:00:00Z', 'e', 't', 'ALLOWED', 'v2:garbage')",
                    [format!("garbage-{i:05}")],
                )
                .unwrap();
            }
            conn.execute(
                "INSERT INTO audit_logs (id, timestamp, event, tool_name, status, payload)
                 VALUES ('old-bad', '2026-01-01T00:00:00Z', 'e', 't', 'ALLOWED', ?1)",
                [BAD],
            )
            .unwrap();
        }
        set_metadata(&path, FORMAT_KEY, None);
        assert!(key_check_value(&path).is_some());
        drop(AuditVault::new(&path, Some("right")).unwrap());
        assert_eq!(format_marker(&path).as_deref(), Some("v2"));
        fs::remove_file(&path).ok();
    }

    #[test]
    fn binding_holds_after_migration() {
        let path = temp_db_path();
        let rows = legacy_db(&path, 3);
        let vault = AuditVault::new(&path, Some(LEGACY_KEY_PASSPHRASE)).unwrap();
        let id0 = rows[0].0.clone();
        let id1 = rows[1].0.clone();
        let id2 = rows[2].0.clone();
        // Move a migrated payload to another row, and another row to a new namespace.
        let payload0 = raw_payload(&path, &id0);
        set_payload(&path, &id1, &payload0);
        {
            let conn = vault.get_connection();
            let conn = conn.lock().unwrap();
            conn.execute(
                "UPDATE audit_logs SET namespace = 'other_tenant' WHERE id = ?1",
                [&id2],
            )
            .unwrap();
        }
        let read = vault.get_recent(10).unwrap();
        let r0 = read.iter().find(|r| r.id == id0).unwrap();
        let r1 = read.iter().find(|r| r.id == id1).unwrap();
        let r2 = read.iter().find(|r| r.id == id2).unwrap();
        assert_eq!(r0.payload.as_deref(), Some("secret 0"));
        assert!(r1.payload.as_deref().unwrap().starts_with("v2:"));
        assert!(r2.payload.as_deref().unwrap().starts_with("v2:"));
        drop(vault);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn malformed_v2_records_return_none_without_panic() {
        let good = encrypt_payload(&TEST_KEY, ID_A, None, "payload").unwrap();
        let nonce = good.split(':').nth(1).unwrap().to_string();
        let ct = good.split(':').nth(2).unwrap().to_string();
        let cases = [
            "v2:".to_string(),
            "v2:abc".to_string(),
            format!("v2:{nonce}"),
            format!("v2:{nonce}:{ct}:extra"),
            "v2:!!!:!!!".to_string(),
            format!("v2:{nonce}:!!!"),
            format!("v2::{ct}"),
            format!("v2:v2:{nonce}:{ct}"),
        ];
        for case in cases {
            assert_eq!(
                decrypt_payload(&TEST_KEY, ID_A, None, &case),
                None,
                "{case}"
            );
        }
    }

    #[test]
    fn v2_record_with_prefix_stripped_does_not_decrypt() {
        let stored = encrypt_payload(&TEST_KEY, ID_A, None, "payload").unwrap();
        let stripped = stored.strip_prefix("v2:").unwrap();
        assert_eq!(decrypt_payload(&TEST_KEY, ID_A, None, stripped), None);
    }

    #[test]
    fn v2_record_is_bound_to_its_namespace() {
        let namespaces = [Some("a"), None, Some("")];
        for (i, written) in namespaces.iter().enumerate() {
            let stored = encrypt_payload(&TEST_KEY, ID_A, *written, "payload").unwrap();
            for (j, read) in namespaces.iter().enumerate() {
                let got = decrypt_payload(&TEST_KEY, ID_A, *read, &stored);
                if i == j {
                    assert_eq!(got.as_deref(), Some("payload"));
                } else {
                    assert_eq!(got, None, "written {written:?}, read {read:?}");
                }
            }
        }
    }

    #[test]
    fn record_moved_to_another_namespace_is_not_readable() {
        let path = temp_db_path();
        let vault = AuditVault::new(&path, Some("test-passphrase")).expect("vault");
        let mut entry = AuditEntry::new("event_a", "tool", "ALLOWED");
        entry.payload = Some("tenant a secret".to_string());
        entry.namespace = Some("tenant_a".to_string());
        vault.log(entry).unwrap();
        let before = vault.get_recent_by_namespace("tenant_a", 10).unwrap();
        assert_eq!(before[0].payload.as_deref(), Some("tenant a secret"));
        {
            let conn = vault.get_connection();
            let conn = conn.lock().unwrap();
            conn.execute(
                "UPDATE audit_logs SET namespace = 'tenant_b' WHERE namespace = 'tenant_a'",
                [],
            )
            .unwrap();
        }
        let moved = vault.get_recent_by_namespace("tenant_b", 10).unwrap();
        assert_eq!(moved.len(), 1);
        let text = moved[0].payload.as_deref().unwrap();
        assert!(text.starts_with("v2:"));
        assert!(!text.contains("tenant a secret"));
        fs::remove_file(&path).ok();
    }
}
