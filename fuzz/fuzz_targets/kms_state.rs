//! The KMS data-key state file: it sits next to the audit database and holds the encrypted key. A damaged
//! or edited file must stop the start with an error, never silently give a new key.
//!
//! Input: one flag byte, then the bytes of the state file.
//!   bit 0  the recovery flag (a new key may replace a damaged file)
//!   bit 1  the stand-in KMS returns a plaintext key of the wrong length
//!   bit 2  the stand-in KMS refuses to decrypt
#![no_main]

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use libfuzzer_sys::fuzz_target;
use std::cell::RefCell;
use zn::crypto::kms_vault::{AwsKmsVault, GeneratedKey, KmsApi};
use zn::crypto::vault::SecretVault;

const KEY_ID: &str = "alias/fictional-fuzz-key";

struct StandIn {
    wrong_length: bool,
    refuse: bool,
}

#[async_trait]
impl KmsApi for StandIn {
    async fn generate_data_key(&self, key_id: &str, _context: (&str, &str)) -> Result<GeneratedKey> {
        let plaintext = vec![7u8; if self.wrong_length { 31 } else { 32 }];
        let mut ciphertext = key_id.as_bytes().to_vec();
        ciphertext.extend(plaintext.iter().rev());
        Ok(GeneratedKey { plaintext, ciphertext })
    }

    async fn decrypt(&self, key_id: &str, ciphertext: &[u8], _context: (&str, &str)) -> Result<Vec<u8>> {
        if self.refuse {
            return Err(anyhow!("AccessDenied"));
        }
        let rest = ciphertext
            .strip_prefix(key_id.as_bytes())
            .ok_or_else(|| anyhow!("InvalidCiphertext"))?;
        Ok(rest.iter().rev().copied().collect())
    }

    async fn sign(&self, _key_id: &str, _data: &[u8]) -> Result<Vec<u8>> {
        Ok(vec![1, 2, 3])
    }
}

struct Fixture {
    dir: tempfile::TempDir,
    runtime: tokio::runtime::Runtime,
}

thread_local! {
    static FIXTURE: RefCell<Fixture> = RefCell::new(Fixture {
        dir: tempfile::tempdir().expect("a scratch folder"),
        runtime: tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("a runtime"),
    });
}

fuzz_target!(|data: &[u8]| {
    let Some((&flags, file)) = data.split_first() else {
        return;
    };
    FIXTURE.with(|fixture| {
        let fixture = fixture.borrow();
        let state_path = fixture.dir.path().join("zn-kms-data-key.json");
        std::fs::write(&state_path, file).expect("write the state file");

        let recover = flags & 1 != 0;
        let api = StandIn {
            wrong_length: flags & 2 != 0,
            refuse: flags & 4 != 0,
        };
        let vault = AwsKmsVault::with_api(Box::new(api), state_path.clone(), recover);
        let result = fixture.runtime.block_on(vault.get_encryption_key(KEY_ID));

        match result {
            // Whatever the file held, a key is always 32 bytes.
            Ok(key) => assert_eq!(key.len(), 32),
            // A refusal leaves the file as it was: nothing is overwritten on a failed start.
            Err(_) => assert_eq!(std::fs::read(&state_path).expect("read back"), file),
        }
    });
});
