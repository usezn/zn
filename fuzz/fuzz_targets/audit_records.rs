//! Audit records read back from the database: the stored text is what the decryption has to survive,
//! after a corrupt file, a restored backup or a record moved between rows.
//!
//! Input: one mode byte, then the payload.
//!   mode 0 (even)  a row built from five fields split at 0x1F: id, namespace, payload, nearest neighbour, fusion
//!   mode 1 (odd)   a genuine encrypted record whose stored text is edited at positions taken from the payload
//!                  (pairs of position and byte), and whose namespace may be changed
#![no_main]

use libfuzzer_sys::fuzz_target;
use std::cell::RefCell;
use zn::audit::{AuditEntry, AuditVault};

const PASSPHRASE: &str = "fictional-fuzz-passphrase";
const PLAINTEXT: &str = "{\"note\":\"fictional payload for example.com\"}";

struct Fixture {
    _dir: tempfile::TempDir,
    vault: AuditVault,
}

thread_local! {
    static FIXTURE: RefCell<Fixture> = RefCell::new({
        let dir = tempfile::tempdir().expect("a scratch folder");
        let path = dir.path().join("audit.db");
        // The key is derived once; every input reuses the open vault.
        let vault = AuditVault::new(path.to_str().expect("utf-8 path"), Some(PASSPHRASE))
            .expect("the vault opens");
        Fixture { _dir: dir, vault }
    });
}

fn opt(field: &str) -> Option<String> {
    if field.is_empty() {
        None
    } else {
        Some(field.to_string())
    }
}

fuzz_target!(|data: &[u8]| {
    let Some((&mode, rest)) = data.split_first() else {
        return;
    };
    FIXTURE.with(|fixture| {
        let fixture = fixture.borrow();
        let vault = &fixture.vault;
        let conn = vault.get_connection();
        let conn = conn.lock().expect("the connection lock");
        conn.execute("DELETE FROM audit_logs", []).expect("clear the table");

        if mode % 2 == 0 {
            let text = String::from_utf8_lossy(rest);
            let mut fields = text.splitn(5, '\u{1f}');
            let id = fields.next().unwrap_or("");
            let namespace = opt(fields.next().unwrap_or(""));
            let payload = opt(fields.next().unwrap_or(""));
            let neighbour = opt(fields.next().unwrap_or(""));
            let fusion = opt(fields.next().unwrap_or(""));
            let _ = conn.execute(
                "INSERT OR REPLACE INTO audit_logs \
                 (id, timestamp, event, tool_name, status, namespace, payload, nearest_neighbor, fusion) \
                 VALUES (?1, '2026-01-01T00:00:00+00:00', 'TOOL_CALL', 'tool', 'ALLOWED', ?2, ?3, ?4, ?5)",
                [Some(id.to_string()), namespace.clone(), payload, neighbour, fusion],
            );
            drop(conn);
            let _ = vault.get_recent(10);
            let _ = vault.stats();
            if let Some(ns) = namespace {
                let _ = vault.get_recent_by_namespace(&ns, 10);
                let _ = vault.stats_by_namespace(&ns);
            }
            return;
        }

        // A genuine record first, written through the vault.
        drop(conn);
        let entry = AuditEntry::new("TOOL_CALL", "tool", "ALLOWED")
            .with_namespace("example-team")
            .with_payload(PLAINTEXT);
        let id = entry.id.clone();
        vault.log(entry).expect("log a record");
        let conn = vault.get_connection();
        let conn = conn.lock().expect("the connection lock");
        let stored: String = conn
            .query_row("SELECT payload FROM audit_logs WHERE id = ?1", [&id], |r| r.get(0))
            .expect("the record is stored");

        let mut edited = stored.clone().into_bytes();
        let mut positions = rest.chunks_exact(2);
        for pair in &mut positions {
            if edited.is_empty() {
                break;
            }
            let at = pair[0] as usize % edited.len();
            edited[at] = pair[1];
        }
        // An odd trailing byte truncates the record.
        if let Some(&cut) = positions.remainder().first() {
            let keep = (cut as usize * edited.len() / 255).min(edited.len());
            edited.truncate(keep);
        }
        let edited = String::from_utf8_lossy(&edited).into_owned();
        let moved = rest.first().is_some_and(|b| b & 0x80 != 0);
        conn.execute(
            "UPDATE audit_logs SET payload = ?1, namespace = ?2 WHERE id = ?3",
            [
                edited.clone(),
                if moved { "example-other".to_string() } else { "example-team".to_string() },
                id,
            ],
        )
        .expect("update the record");
        drop(conn);

        let tampered = edited != stored || moved;
        let rows = vault.get_recent(10).expect("the rows are listed");
        assert_eq!(rows.len(), 1);
        if tampered {
            // A changed record, or one moved to another namespace, must not open.
            assert_ne!(rows[0].payload.as_deref(), Some(PLAINTEXT), "tampering was not detected");
        } else {
            assert_eq!(rows[0].payload.as_deref(), Some(PLAINTEXT));
        }
    });
});
