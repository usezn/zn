//! Failure paths of the audit vault: each one must refuse (return an error),
//! must not leave plaintext in the database file, and must not report success.
//!
//! The vault reports these failures to its caller as errors with a message that
//! names the step that failed; it does not write them to the log itself, so the
//! tests assert on the returned message. Locks are held by a second connection
//! to the same file, which makes the 5 second busy timeout expire.

use super::*;
use std::fs;

const PASS: &str = "example-passphrase-not-secret";
const SECRET: &str = "example-secret-payload-0001";

fn path() -> String {
    format!("test_audit_failure_{}.db", Uuid::new_v4())
}

fn cleanup(p: &str) {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        fs::remove_file(format!("{p}{suffix}")).ok();
    }
}

fn file_has(p: &str, needle: &str) -> bool {
    ["", "-wal", "-journal"]
        .iter()
        .filter_map(|s| fs::read(format!("{p}{s}")).ok())
        .any(|b| b.windows(needle.len()).any(|w| w == needle.as_bytes()))
}

fn derived_key(p: &str) -> [u8; 32] {
    let conn = Connection::open(p).unwrap();
    let salt_hex: String = conn
        .query_row(
            "SELECT value FROM metadata WHERE key = 'derivation_salt'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    derive_key(PASS, &hex::decode(salt_hex).unwrap()).unwrap()
}

fn old_format_record(key: &[u8; 32], plaintext: &str) -> String {
    let nonce_bytes = random_nonce_bytes();
    let encrypted = Aes256Gcm::new(key.into())
        .encrypt(&Nonce::from(nonce_bytes), plaintext.as_bytes())
        .unwrap();
    format!(
        "{}:{}",
        general_purpose::STANDARD.encode(nonce_bytes),
        general_purpose::STANDARD.encode(encrypted)
    )
}

/// Keyed database with one record in the old format and no upgrade marker.
/// Returns the path and the stored old-format payload.
fn old_format_db() -> (String, String) {
    let p = path();
    drop(AuditVault::new(&p, Some(PASS)).unwrap());
    let stored = old_format_record(&derived_key(&p), SECRET);
    let conn = Connection::open(&p).unwrap();
    conn.execute(
        "INSERT INTO audit_logs (id, timestamp, event, tool_name, status, payload)
         VALUES ('old-1', '2026-01-01T00:00:00Z', 'e', 't', 'ALLOWED', ?1)",
        [&stored],
    )
    .unwrap();
    conn.execute("DELETE FROM metadata WHERE key = 'audit_format'", [])
        .unwrap();
    (p, stored)
}

fn raw_payload(p: &str) -> String {
    Connection::open(p)
        .unwrap()
        .query_row(
            "SELECT payload FROM audit_logs WHERE id = 'old-1'",
            [],
            |r| r.get(0),
        )
        .unwrap()
}

fn metadata(p: &str, key: &str) -> Option<String> {
    Connection::open(p)
        .unwrap()
        .query_row("SELECT value FROM metadata WHERE key = ?1", [key], |r| {
            r.get(0)
        })
        .ok()
}

fn err_of(r: Result<AuditVault>) -> String {
    match r {
        Ok(_) => panic!("the vault must refuse to open"),
        Err(e) => e.to_string(),
    }
}

#[test]
fn opening_a_directory_as_the_database_fails_with_a_named_error() {
    let dir = format!("test_audit_failure_dir_{}", Uuid::new_v4());
    fs::create_dir(&dir).unwrap();
    let err = err_of(AuditVault::new(&dir, None));
    assert!(err.contains("Failed to open audit database"), "{err}");
    fs::remove_dir(&dir).ok();
}

#[test]
fn damaged_stored_salt_is_refused_before_anything_is_written() {
    for (bad, expected) in [
        ("not-hex!", "Failed to decode salt"),
        ("abcd", "Failed to derive encryption key"),
    ] {
        let p = path();
        drop(AuditVault::new(&p, Some(PASS)).unwrap());
        let conn = Connection::open(&p).unwrap();
        conn.execute(
            "UPDATE metadata SET value = ?1 WHERE key = 'derivation_salt'",
            [bad],
        )
        .unwrap();
        conn.execute("DELETE FROM metadata WHERE key = 'key_check'", [])
            .unwrap();
        drop(conn);
        let err = err_of(AuditVault::new(&p, Some(PASS)));
        assert!(err.contains(expected), "{err}");
        assert!(
            metadata(&p, KEY_CHECK_KEY).is_none(),
            "no key check written"
        );
        cleanup(&p);
    }
}

#[test]
fn a_failed_key_check_write_refuses_the_open() {
    let p = path();
    drop(AuditVault::new(&p, Some(PASS)).unwrap());
    let conn = Connection::open(&p).unwrap();
    conn.execute("DELETE FROM metadata WHERE key = 'key_check'", [])
        .unwrap();
    conn.execute_batch(
        "CREATE TRIGGER block_key_check BEFORE INSERT ON metadata
         WHEN NEW.key = 'key_check' BEGIN SELECT RAISE(ABORT, 'key check blocked'); END;",
    )
    .unwrap();
    drop(conn);
    let err = err_of(AuditVault::new(&p, Some(PASS)));
    assert!(err.contains("key check blocked"), "{err}");
    assert!(metadata(&p, KEY_CHECK_KEY).is_none());
    cleanup(&p);
}

#[test]
fn a_failed_record_update_rolls_the_upgrade_back() {
    let (p, stored) = old_format_db();
    Connection::open(&p)
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER block_update BEFORE UPDATE ON audit_logs
             BEGIN SELECT RAISE(ABORT, 'update blocked'); END;",
        )
        .unwrap();
    let err = err_of(AuditVault::new(&p, Some(PASS)));
    assert!(err.contains("update blocked"), "{err}");
    assert_eq!(raw_payload(&p), stored, "record unchanged");
    assert!(metadata(&p, FORMAT_KEY).is_none(), "no upgrade marker");
    assert!(!file_has(&p, SECRET));
    cleanup(&p);
}

#[test]
fn a_failed_marker_write_leaves_no_half_upgraded_records() {
    let (p, stored) = old_format_db();
    Connection::open(&p)
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER block_marker BEFORE INSERT ON metadata
             WHEN NEW.key = 'audit_format' BEGIN SELECT RAISE(ABORT, 'marker blocked'); END;",
        )
        .unwrap();
    let err = err_of(AuditVault::new(&p, Some(PASS)));
    assert!(err.contains("marker blocked"), "{err}");
    assert_eq!(raw_payload(&p), stored, "the rewrite was rolled back");
    assert!(metadata(&p, FORMAT_KEY).is_none());
    cleanup(&p);
}

#[test]
fn the_upgrade_does_not_start_while_another_writer_holds_the_file() {
    let (p, stored) = old_format_db();
    let holder = Connection::open(&p).unwrap();
    holder.execute_batch("BEGIN IMMEDIATE").unwrap();
    let err = err_of(AuditVault::new(&p, Some(PASS)));
    assert!(err.contains("Failed to start audit upgrade"), "{err}");
    holder.execute_batch("ROLLBACK").unwrap();
    assert_eq!(raw_payload(&p), stored);
    assert!(!file_has(&p, SECRET));
    // Once the lock is gone the same database opens and upgrades.
    drop(AuditVault::new(&p, Some(PASS)).expect("opens after the lock is released"));
    assert!(raw_payload(&p).starts_with(V2_PREFIX));
    cleanup(&p);
}

#[test]
fn the_upgrade_commit_fails_closed_while_a_reader_holds_the_file() {
    let (p, stored) = old_format_db();
    let reader = Connection::open(&p).unwrap();
    reader.execute_batch("BEGIN").unwrap();
    let _: i64 = reader
        .query_row("SELECT COUNT(*) FROM audit_logs", [], |r| r.get(0))
        .unwrap();
    let err = err_of(AuditVault::new(&p, Some(PASS)));
    assert!(
        err.contains("Failed to commit audit upgrade") || err.contains("locked"),
        "{err}"
    );
    reader.execute_batch("ROLLBACK").unwrap();
    assert_eq!(raw_payload(&p), stored, "nothing was rewritten");
    assert!(metadata(&p, FORMAT_KEY).is_none());
    drop(AuditVault::new(&p, Some(PASS)).expect("opens after the reader is gone"));
    assert!(raw_payload(&p).starts_with(V2_PREFIX));
    cleanup(&p);
}

fn pending_compaction_db() -> String {
    let p = path();
    drop(AuditVault::new(&p, None).unwrap());
    Connection::open(&p)
        .unwrap()
        .execute(
            "INSERT INTO metadata (key, value) VALUES ('neighbours_vacuum_pending', '1')",
            [],
        )
        .unwrap();
    p
}

#[test]
fn a_pending_compaction_that_cannot_run_refuses_the_open_and_keeps_the_marker() {
    let p = pending_compaction_db();
    let reader = Connection::open(&p).unwrap();
    reader.execute_batch("BEGIN").unwrap();
    let _: i64 = reader
        .query_row("SELECT COUNT(*) FROM audit_logs", [], |r| r.get(0))
        .unwrap();
    let err = err_of(AuditVault::new(&p, None));
    // The lock is hit before the compaction statement itself, so the message is
    // SQLite's own; either way the open is refused.
    assert!(
        err.contains("locked") || err.contains("Failed to compact the audit database"),
        "{err}"
    );
    reader.execute_batch("ROLLBACK").unwrap();
    assert_eq!(
        metadata(&p, "neighbours_vacuum_pending").as_deref(),
        Some("1"),
        "the marker stays so the next start retries"
    );
    drop(AuditVault::new(&p, None).expect("compacts once the reader is gone"));
    assert!(metadata(&p, "neighbours_vacuum_pending").is_none());
    cleanup(&p);
}

#[test]
fn an_incomplete_checkpoint_after_compaction_refuses_the_open_and_keeps_the_marker() {
    let p = pending_compaction_db();
    let conn = Connection::open(&p).unwrap();
    let mode: String = conn
        .query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
    drop(conn);
    let reader = Connection::open(&p).unwrap();
    reader.execute_batch("BEGIN").unwrap();
    let _: i64 = reader
        .query_row("SELECT COUNT(*) FROM audit_logs", [], |r| r.get(0))
        .unwrap();
    let err = err_of(AuditVault::new(&p, None));
    assert!(err.contains("checkpoint incomplete"), "{err}");
    reader.execute_batch("ROLLBACK").unwrap();
    assert_eq!(
        metadata(&p, "neighbours_vacuum_pending").as_deref(),
        Some("1")
    );
    drop(AuditVault::new(&p, None).expect("retry succeeds"));
    assert!(metadata(&p, "neighbours_vacuum_pending").is_none());
    cleanup(&p);
}

#[test]
fn a_failed_insert_returns_an_error_and_writes_no_plaintext() {
    let p = path();
    let vault = AuditVault::new(&p, Some(PASS)).unwrap();
    Connection::open(&p)
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER block_insert BEFORE INSERT ON audit_logs
             BEGIN SELECT RAISE(ABORT, 'insert blocked'); END;",
        )
        .unwrap();
    let mut e = AuditEntry::new("event", "tool", "ALLOWED");
    e.payload = Some(SECRET.to_string());
    let err = vault.log(e).expect_err("the write must fail").to_string();
    assert!(err.contains("insert blocked"), "{err}");
    assert_eq!(vault.count().unwrap(), 0);
    assert!(!file_has(&p, SECRET), "no plaintext in the file");
    cleanup(&p);
}

#[test]
fn a_duplicate_id_is_an_error_and_never_overwrites_the_first_record() {
    let p = path();
    let vault = AuditVault::new(&p, Some(PASS)).unwrap();
    let mut first = AuditEntry::new("event", "tool", "ALLOWED");
    first.payload = Some(SECRET.to_string());
    let mut second = first.clone();
    second.payload = Some("example-second-payload".to_string());
    vault.log(first).unwrap();
    assert!(vault.log(second).is_err());
    assert_eq!(vault.count().unwrap(), 1);
    assert_eq!(
        vault.get_recent(1).unwrap()[0].payload.as_deref(),
        Some(SECRET)
    );
    assert!(!file_has(&p, SECRET));
    assert!(!file_has(&p, "example-second-payload"));
    cleanup(&p);
}

#[test]
fn a_poisoned_lock_makes_every_vault_call_fail_and_log_writes_nothing() {
    let p = path();
    let vault = AuditVault::new(&p, Some(PASS)).unwrap();
    let conn = vault.get_connection();
    let _ = std::thread::spawn(move || {
        let _guard = conn.lock().unwrap();
        panic!("poison the lock on purpose");
    })
    .join();

    let mut e = AuditEntry::new("event", "tool", "ALLOWED");
    e.payload = Some(SECRET.to_string());
    let msgs = [
        vault.log(e).unwrap_err().to_string(),
        vault.get_recent(1).unwrap_err().to_string(),
        vault
            .get_recent_by_namespace("tenant", 1)
            .unwrap_err()
            .to_string(),
        vault.stats().unwrap_err().to_string(),
        vault.stats_by_namespace("tenant").unwrap_err().to_string(),
        vault.count().unwrap_err().to_string(),
    ];
    for m in msgs {
        assert!(m.contains("Lock poisoned"), "{m}");
    }
    let rows: i64 = Connection::open(&p)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM audit_logs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 0);
    assert!(!file_has(&p, SECRET));
    cleanup(&p);
}

#[test]
fn queries_on_a_vault_whose_table_is_gone_return_errors() {
    let p = path();
    let vault = AuditVault::new(&p, None).unwrap();
    Connection::open(&p)
        .unwrap()
        .execute_batch("DROP TABLE audit_logs")
        .unwrap();
    let e1 = vault.get_recent(1).unwrap_err().to_string();
    // The statement was prepared before the table was dropped, so SQLite reports
    // the missing table when it runs, not when it is prepared.
    assert!(e1.contains("no such table"), "{e1}");
    let e2 = vault
        .get_recent_by_namespace("tenant", 1)
        .unwrap_err()
        .to_string();
    assert!(e2.contains("no such table"), "{e2}");
    assert!(vault.stats().is_err());
    assert!(vault.stats_by_namespace("tenant").is_err());
    assert!(vault.count().is_err());
    assert!(vault
        .log(AuditEntry::new("event", "tool", "ALLOWED"))
        .is_err());
    cleanup(&p);
}
