//! Known-answer tests for the audit log key derivation.
//!
//! The expected key was computed outside this code base with Python argon2-cffi
//! (`hash_secret_raw`, Argon2id, version 0x13, m = 19456 KiB, t = 2, p = 1, 32 bytes).
//! If a dependency upgrade changes the output, databases written earlier can no longer be
//! decrypted, so these tests must fail instead of the data becoming unreadable.

use super::*;
use std::fs;

const PASSPHRASE: &str = "example-passphrase-not-secret";
const SALT_HEX: &str = "101112131415161718191a1b1c1d1e1f";
const EXPECTED_KEY_HEX: &str = "0507113c50a1338ce5d79bc7ea380ec48f43bb7941fb9c345e2326689dc6f59a";

#[test]
fn derive_key_matches_known_answer() {
    let salt = hex::decode(SALT_HEX).unwrap();
    let key = derive_key(PASSPHRASE, &salt).unwrap();
    assert_eq!(hex::encode(key), EXPECTED_KEY_HEX);
}

#[test]
fn vault_uses_stored_salt_to_derive_the_pinned_key() {
    let path = format!("test_audit_kat_{}.db", Uuid::new_v4());
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute(
            "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO metadata (key, value) VALUES ('derivation_salt', ?1)",
            [SALT_HEX],
        )
        .unwrap();
    }
    let vault = AuditVault::new(&path, Some(PASSPHRASE)).unwrap();
    let key = vault.encryption_key.expect("encryption key present");
    assert_eq!(hex::encode(key), EXPECTED_KEY_HEX);
    drop(vault);
    fs::remove_file(&path).ok();
}
