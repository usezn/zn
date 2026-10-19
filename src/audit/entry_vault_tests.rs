//! Unit tests for `AuditEntry`, `FusionEvidence`, `VaultStats` and `AuditVault`
//! (construction, serde, storage, statistics and on-disk persistence).
//!
//! All values are fictitious. Databases live in a temporary directory that is
//! removed when the test ends.

use super::*;
use tempfile::TempDir;

const KEY: &str = "example-passphrase-not-secret";

fn db_in(dir: &TempDir) -> String {
    dir.path().join("audit.db").to_string_lossy().into_owned()
}

fn entry_at(ts: &str, tool: &str, status: &str) -> AuditEntry {
    let mut e = AuditEntry::new("TOOL_CALL", tool, status);
    e.timestamp = ts.to_string();
    e
}

fn evidence() -> FusionEvidence {
    FusionEvidence {
        cameras: vec!["rules".into(), "neural".into()],
        neural_score: 0.875,
        tau: 0.5,
        model_id: "example-model-1".into(),
    }
}

// ---------------------------------------------------------------- AuditEntry

#[test]
fn new_entry_has_valid_id_timestamp_and_empty_options() {
    let e = AuditEntry::new("TOOL_CALL", "read_file", "ALLOWED");
    assert!(Uuid::parse_str(&e.id).is_ok(), "id is a UUID: {}", e.id);
    assert!(
        chrono::DateTime::parse_from_rfc3339(&e.timestamp).is_ok(),
        "timestamp is RFC 3339: {}",
        e.timestamp
    );
    assert_eq!(e.event, "TOOL_CALL");
    assert_eq!(e.tool_name, "read_file");
    assert_eq!(e.status, "ALLOWED");
    assert!(e.policy_match.is_none());
    assert!(e.payload.is_none());
    assert!(e.agent_id.is_none());
    assert!(e.namespace.is_none());
    assert!(e.anomaly_score.is_none());
    assert!(e.nearest_neighbor.is_none());
    assert!(e.fusion.is_none());
}

#[test]
fn new_entries_get_distinct_ids() {
    let a = AuditEntry::new("E", "t", "ALLOWED");
    let b = AuditEntry::new("E", "t", "ALLOWED");
    assert_ne!(a.id, b.id);
}

#[test]
fn builders_set_every_optional_field() {
    let e = AuditEntry::new("POLICY_DENY", "bash", "DENIED")
        .with_policy("restricted_commands")
        .with_payload("{\"cmd\":\"ls\"}")
        .with_agent_id("agent-example")
        .with_nearest_neighbor("example text:0.25")
        .with_fusion(evidence());
    assert_eq!(e.policy_match.as_deref(), Some("restricted_commands"));
    assert_eq!(e.payload.as_deref(), Some("{\"cmd\":\"ls\"}"));
    assert_eq!(e.agent_id.as_deref(), Some("agent-example"));
    assert_eq!(e.nearest_neighbor.as_deref(), Some("example text:0.25"));
    assert_eq!(e.fusion, Some(evidence()));
}

#[test]
fn entry_serde_round_trip_keeps_all_fields() {
    let mut e = AuditEntry::new("TOOL_CALL", "fetch", "DENIED")
        .with_policy("p1")
        .with_payload("body")
        .with_agent_id("agent-example")
        .with_nearest_neighbor("nn:0.1")
        .with_fusion(evidence());
    e.namespace = Some("tenant_example".into());
    e.anomaly_score = Some(0.75);

    let json = serde_json::to_string(&e).unwrap();
    let back: AuditEntry = serde_json::from_str(&json).unwrap();
    assert_eq!(back.id, e.id);
    assert_eq!(back.timestamp, e.timestamp);
    assert_eq!(back.event, e.event);
    assert_eq!(back.tool_name, e.tool_name);
    assert_eq!(back.status, e.status);
    assert_eq!(back.policy_match, e.policy_match);
    assert_eq!(back.payload, e.payload);
    assert_eq!(back.agent_id, e.agent_id);
    assert_eq!(back.namespace, e.namespace);
    assert_eq!(back.anomaly_score, e.anomaly_score);
    assert_eq!(back.nearest_neighbor, e.nearest_neighbor);
    assert_eq!(back.fusion, e.fusion);
}

#[test]
fn entry_without_fusion_key_deserializes_with_none() {
    let json = r#"{
        "id": "id-1", "timestamp": "2026-01-01T00:00:00+00:00",
        "event": "TOOL_CALL", "tool_name": "ls", "status": "ALLOWED",
        "policy_match": null, "payload": null, "agent_id": null,
        "namespace": null, "anomaly_score": null, "nearest_neighbor": null
    }"#;
    let e: AuditEntry = serde_json::from_str(json).unwrap();
    assert!(e.fusion.is_none());
}

#[test]
fn entry_missing_required_field_is_rejected() {
    // `tool_name` is required.
    let json = r#"{
        "id": "id-1", "timestamp": "2026-01-01T00:00:00+00:00",
        "event": "TOOL_CALL", "status": "ALLOWED",
        "policy_match": null, "payload": null, "agent_id": null,
        "namespace": null, "anomaly_score": null, "nearest_neighbor": null
    }"#;
    assert!(serde_json::from_str::<AuditEntry>(json).is_err());
}

// ------------------------------------------------------------ FusionEvidence

#[test]
fn fusion_evidence_round_trip_and_equality() {
    let ev = evidence();
    let json = serde_json::to_string(&ev).unwrap();
    let back: FusionEvidence = serde_json::from_str(&json).unwrap();
    assert_eq!(back, ev);

    let mut other = ev.clone();
    other.tau = 0.6;
    assert_ne!(other, ev);
}

#[test]
fn fusion_evidence_missing_field_is_rejected() {
    let json = r#"{"cameras":["rules"],"neural_score":0.5,"tau":0.5}"#;
    assert!(serde_json::from_str::<FusionEvidence>(json).is_err());
}

#[test]
fn fusion_evidence_with_empty_cameras_round_trips() {
    let ev = FusionEvidence {
        cameras: Vec::new(),
        neural_score: 0.0,
        tau: 1.0,
        model_id: String::new(),
    };
    let back: FusionEvidence = serde_json::from_str(&serde_json::to_string(&ev).unwrap()).unwrap();
    assert_eq!(back, ev);
}

// --------------------------------------------------------------- VaultStats

#[test]
fn vault_stats_serde_round_trip() {
    let s = VaultStats {
        total: 5,
        allowed: 3,
        denied: 2,
    };
    let json = serde_json::to_string(&s).unwrap();
    assert_eq!(json, r#"{"total":5,"allowed":3,"denied":2}"#);
    let back: VaultStats = serde_json::from_str(&json).unwrap();
    assert_eq!((back.total, back.allowed, back.denied), (5, 3, 2));
}

#[test]
fn empty_vault_has_zero_stats() {
    let dir = TempDir::new().unwrap();
    let vault = AuditVault::new(&db_in(&dir), None).unwrap();
    let s = vault.stats().unwrap();
    assert_eq!((s.total, s.allowed, s.denied), (0, 0, 0));
    assert!(vault.get_recent(10).unwrap().is_empty());
}

#[test]
fn stats_count_only_allowed_and_denied_separately() {
    let dir = TempDir::new().unwrap();
    let vault = AuditVault::new(&db_in(&dir), None).unwrap();
    vault.log(AuditEntry::new("E", "a", "ALLOWED")).unwrap();
    vault.log(AuditEntry::new("E", "b", "DENIED")).unwrap();
    vault.log(AuditEntry::new("E", "c", "DENIED")).unwrap();
    vault.log(AuditEntry::new("E", "d", "WARNED")).unwrap();

    let s = vault.stats().unwrap();
    assert_eq!(s.total, 4);
    assert_eq!(s.allowed, 1);
    assert_eq!(s.denied, 2);
    assert_eq!(vault.count().unwrap(), 4);
}

#[test]
fn stats_by_namespace_unknown_namespace_is_zero() {
    let dir = TempDir::new().unwrap();
    let vault = AuditVault::new(&db_in(&dir), None).unwrap();
    let mut e = AuditEntry::new("E", "a", "ALLOWED");
    e.namespace = Some("tenant_a".into());
    vault.log(e).unwrap();

    let s = vault.stats_by_namespace("nobody").unwrap();
    assert_eq!((s.total, s.allowed, s.denied), (0, 0, 0));
    let s = vault.stats_by_namespace("tenant_a").unwrap();
    assert_eq!((s.total, s.allowed, s.denied), (1, 1, 0));
}

// -------------------------------------------------------------- AuditVault

#[test]
fn log_round_trips_every_field() {
    let dir = TempDir::new().unwrap();
    let vault = AuditVault::new(&db_in(&dir), None).unwrap();
    let mut e = entry_at("2026-01-01T00:00:00+00:00", "fetch", "DENIED")
        .with_policy("p1")
        .with_payload("{\"url\":\"https://example.com/\"}")
        .with_agent_id("agent-example")
        .with_nearest_neighbor("nn:0.1")
        .with_fusion(evidence());
    e.namespace = Some("tenant_example".into());
    e.anomaly_score = Some(0.5);
    let id = e.id.clone();
    vault.log(e).unwrap();

    let got = &vault.get_recent(10).unwrap()[0];
    assert_eq!(got.id, id);
    assert_eq!(got.timestamp, "2026-01-01T00:00:00+00:00");
    assert_eq!(got.event, "TOOL_CALL");
    assert_eq!(got.tool_name, "fetch");
    assert_eq!(got.status, "DENIED");
    assert_eq!(got.policy_match.as_deref(), Some("p1"));
    assert_eq!(
        got.payload.as_deref(),
        Some("{\"url\":\"https://example.com/\"}")
    );
    assert_eq!(got.agent_id.as_deref(), Some("agent-example"));
    assert_eq!(got.namespace.as_deref(), Some("tenant_example"));
    assert_eq!(got.anomaly_score, Some(0.5));
    assert_eq!(got.nearest_neighbor.as_deref(), Some("nn:0.1"));
    assert_eq!(got.fusion, Some(evidence()));
}

#[test]
fn duplicate_id_is_rejected() {
    let dir = TempDir::new().unwrap();
    let vault = AuditVault::new(&db_in(&dir), None).unwrap();
    let e = AuditEntry::new("E", "a", "ALLOWED");
    vault.log(e.clone()).unwrap();
    assert!(vault.log(e).is_err());
    assert_eq!(vault.count().unwrap(), 1);
}

#[test]
fn get_recent_is_newest_first_and_honors_limit() {
    let dir = TempDir::new().unwrap();
    let vault = AuditVault::new(&db_in(&dir), None).unwrap();
    vault
        .log(entry_at("2026-01-01T00:00:01+00:00", "first", "ALLOWED"))
        .unwrap();
    vault
        .log(entry_at("2026-01-01T00:00:03+00:00", "third", "ALLOWED"))
        .unwrap();
    vault
        .log(entry_at("2026-01-01T00:00:02+00:00", "second", "ALLOWED"))
        .unwrap();

    let all: Vec<String> = vault
        .get_recent(10)
        .unwrap()
        .into_iter()
        .map(|e| e.tool_name)
        .collect();
    assert_eq!(all, ["third", "second", "first"]);

    let two = vault.get_recent(2).unwrap();
    assert_eq!(two.len(), 2);
    assert_eq!(two[0].tool_name, "third");
    assert!(vault.get_recent(0).unwrap().is_empty());
}

#[test]
fn get_recent_by_namespace_honors_limit_and_filter() {
    let dir = TempDir::new().unwrap();
    let vault = AuditVault::new(&db_in(&dir), None).unwrap();
    for (i, ns) in ["a", "a", "b", "a"].iter().enumerate() {
        let mut e = entry_at(&format!("2026-01-01T00:00:0{i}+00:00"), "t", "ALLOWED");
        e.namespace = Some((*ns).into());
        vault.log(e).unwrap();
    }
    assert_eq!(vault.get_recent_by_namespace("a", 10).unwrap().len(), 3);
    assert_eq!(vault.get_recent_by_namespace("a", 2).unwrap().len(), 2);
    assert_eq!(vault.get_recent_by_namespace("b", 10).unwrap().len(), 1);
    assert!(vault.get_recent_by_namespace("c", 10).unwrap().is_empty());
}

#[test]
fn entries_without_namespace_are_not_in_any_namespace_query() {
    let dir = TempDir::new().unwrap();
    let vault = AuditVault::new(&db_in(&dir), None).unwrap();
    vault.log(AuditEntry::new("E", "a", "ALLOWED")).unwrap();
    assert!(vault.get_recent_by_namespace("", 10).unwrap().is_empty());
    assert_eq!(vault.get_recent(10).unwrap().len(), 1);
}

#[test]
fn db_path_returns_the_configured_path() {
    let dir = TempDir::new().unwrap();
    let path = db_in(&dir);
    let vault = AuditVault::new(&path, None).unwrap();
    assert_eq!(vault.db_path(), path);
}

#[test]
fn new_fails_for_unopenable_path() {
    let dir = TempDir::new().unwrap();
    let path = dir
        .path()
        .join("missing-subdir")
        .join("audit.db")
        .to_string_lossy()
        .into_owned();
    assert!(AuditVault::new(&path, None).is_err());
}

#[test]
fn entries_persist_across_reopen() {
    let dir = TempDir::new().unwrap();
    let path = db_in(&dir);
    {
        let vault = AuditVault::new(&path, None).unwrap();
        vault.log(AuditEntry::new("E", "a", "ALLOWED")).unwrap();
        vault.log(AuditEntry::new("E", "b", "DENIED")).unwrap();
    }
    let vault = AuditVault::new(&path, None).unwrap();
    assert_eq!(vault.count().unwrap(), 2);
    let s = vault.stats().unwrap();
    assert_eq!((s.total, s.allowed, s.denied), (2, 1, 1));
}

#[test]
fn shared_connection_sees_logged_rows() {
    let dir = TempDir::new().unwrap();
    let vault = AuditVault::new(&db_in(&dir), None).unwrap();
    vault.log(AuditEntry::new("E", "a", "ALLOWED")).unwrap();
    let conn = vault.get_connection();
    let n: i64 = conn
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM audit_logs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn unreadable_fusion_column_yields_none_not_an_error() {
    let dir = TempDir::new().unwrap();
    let vault = AuditVault::new(&db_in(&dir), None).unwrap();
    let e = AuditEntry::new("E", "a", "DENIED").with_fusion(evidence());
    let id = e.id.clone();
    vault.log(e).unwrap();
    vault
        .get_connection()
        .lock()
        .unwrap()
        .execute(
            "UPDATE audit_logs SET fusion = 'not json' WHERE id = ?1",
            [&id],
        )
        .unwrap();
    let got = vault.get_recent(10).unwrap();
    assert_eq!(got.len(), 1);
    assert!(got[0].fusion.is_none());
}

// ------------------------------------------------- encryption and tampering

fn raw_payload(vault: &AuditVault, id: &str) -> String {
    vault
        .get_connection()
        .lock()
        .unwrap()
        .query_row("SELECT payload FROM audit_logs WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .unwrap()
}

#[test]
fn encrypted_payload_is_not_stored_in_clear_and_reads_back_after_reopen() {
    let dir = TempDir::new().unwrap();
    let path = db_in(&dir);
    let e = AuditEntry::new("E", "a", "ALLOWED").with_payload("secret-payload-example");
    let id = e.id.clone();
    {
        let vault = AuditVault::new(&path, Some(KEY)).unwrap();
        vault.log(e).unwrap();
        let raw = raw_payload(&vault, &id);
        assert!(!raw.contains("secret-payload-example"));
    }
    let vault = AuditVault::new(&path, Some(KEY)).unwrap();
    let got = vault.get_recent(10).unwrap();
    assert_eq!(got[0].payload.as_deref(), Some("secret-payload-example"));
}

#[test]
fn swapped_ciphertexts_between_rows_are_not_decrypted() {
    let dir = TempDir::new().unwrap();
    let vault = AuditVault::new(&db_in(&dir), Some(KEY)).unwrap();
    let a = entry_at("2026-01-01T00:00:01+00:00", "a", "ALLOWED").with_payload("payload-a");
    let b = entry_at("2026-01-01T00:00:02+00:00", "b", "ALLOWED").with_payload("payload-b");
    let (ida, idb) = (a.id.clone(), b.id.clone());
    vault.log(a).unwrap();
    vault.log(b).unwrap();
    let (ca, cb) = (raw_payload(&vault, &ida), raw_payload(&vault, &idb));
    {
        let conn = vault.get_connection();
        let conn = conn.lock().unwrap();
        conn.execute(
            "UPDATE audit_logs SET payload = ?1 WHERE id = ?2",
            [&cb, &ida],
        )
        .unwrap();
        conn.execute(
            "UPDATE audit_logs SET payload = ?1 WHERE id = ?2",
            [&ca, &idb],
        )
        .unwrap();
    }
    for e in vault.get_recent(10).unwrap() {
        let p = e.payload.unwrap_or_default();
        assert_ne!(p, "payload-a", "tampered row must not reveal plaintext");
        assert_ne!(p, "payload-b", "tampered row must not reveal plaintext");
    }
}

#[test]
fn modified_ciphertext_is_not_decrypted() {
    let dir = TempDir::new().unwrap();
    let vault = AuditVault::new(&db_in(&dir), Some(KEY)).unwrap();
    let e = AuditEntry::new("E", "a", "ALLOWED").with_payload("payload-a");
    let id = e.id.clone();
    vault.log(e).unwrap();
    let mut raw = raw_payload(&vault, &id);
    // Flip the last base64 character.
    let last = raw.pop().unwrap();
    raw.push(if last == 'A' { 'B' } else { 'A' });
    vault
        .get_connection()
        .lock()
        .unwrap()
        .execute(
            "UPDATE audit_logs SET payload = ?1 WHERE id = ?2",
            [&raw, &id],
        )
        .unwrap();
    let got = vault.get_recent(10).unwrap();
    assert_ne!(got[0].payload.as_deref(), Some("payload-a"));
}
