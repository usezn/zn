//! Opening an audit database that someone else may have edited: the metadata rows (salt, key check, format
//! marker) and the old-format migration run on whatever the file holds.
//!
//! Input: one flag byte, then four fields split at 0x1F: salt, key check, format marker, payload of the one row.
//! Flag bit 0 opens the file without a key (cheap), otherwise with the right passphrase (one key derivation).
#![no_main]

use libfuzzer_sys::fuzz_target;
use std::cell::RefCell;
use zn::audit::{AuditEntry, AuditVault};

const PASSPHRASE: &str = "fictional-fuzz-passphrase";

struct Fixture {
    dir: tempfile::TempDir,
    template: Vec<u8>,
}

thread_local! {
    static FIXTURE: RefCell<Fixture> = RefCell::new({
        let dir = tempfile::tempdir().expect("a scratch folder");
        let path = dir.path().join("template.db");
        {
            let vault = AuditVault::new(path.to_str().expect("utf-8 path"), Some(PASSPHRASE))
                .expect("the vault opens");
            for n in 0..3 {
                vault
                    .log(
                        AuditEntry::new("TOOL_CALL", format!("tool{n}"), "ALLOWED")
                            .with_namespace("example-team")
                            .with_payload("{\"note\":\"fictional payload\"}"),
                    )
                    .expect("log a record");
            }
        }
        let template = std::fs::read(&path).expect("read the template");
        Fixture { dir, template }
    });
}

fn set_metadata(conn: &rusqlite::Connection, key: &str, value: &str) {
    if value.is_empty() {
        let _ = conn.execute("DELETE FROM metadata WHERE key = ?1", [key]);
    } else {
        let _ = conn.execute(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES (?1, ?2)",
            [key, value],
        );
    }
}

fuzz_target!(|data: &[u8]| {
    let Some((&flags, rest)) = data.split_first() else {
        return;
    };
    let text = String::from_utf8_lossy(rest);
    let mut fields = text.splitn(4, '\u{1f}');
    let salt = fields.next().unwrap_or("");
    let check = fields.next().unwrap_or("");
    let marker = fields.next().unwrap_or("");
    let payload = fields.next().unwrap_or("");

    FIXTURE.with(|fixture| {
        let fixture = fixture.borrow();
        let path = fixture.dir.path().join("work.db");
        let _ = std::fs::remove_file(fixture.dir.path().join("work.db-wal"));
        let _ = std::fs::remove_file(fixture.dir.path().join("work.db-shm"));
        std::fs::write(&path, &fixture.template).expect("copy the template");

        {
            let conn = rusqlite::Connection::open(&path).expect("open the copy");
            if !salt.is_empty() {
                set_metadata(&conn, "derivation_salt", salt);
            }
            set_metadata(&conn, "key_check", check);
            set_metadata(&conn, "audit_format", marker);
            if !payload.is_empty() {
                let _ = conn.execute(
                    "UPDATE audit_logs SET payload = ?1 WHERE rowid = (SELECT MIN(rowid) FROM audit_logs)",
                    [payload],
                );
            }
        }

        let key = if flags & 1 != 0 { None } else { Some(PASSPHRASE) };
        if let Ok(vault) = AuditVault::new(path.to_str().expect("utf-8 path"), key) {
            let _ = vault.get_recent(10);
            let _ = vault.stats();
            let _ = vault.log(AuditEntry::new("TOOL_CALL", "after", "ALLOWED"));
        }
    });
});
