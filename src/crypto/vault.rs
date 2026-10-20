//! Secret Vault Abstraction
//!
//! Provides a unified interface for key management, supporting:
//! - Local (In-Memory/Config-based)
//! - HSM (via PKCS#11 - Placeholder)
//! - Cloud KMS (AWS KMS)

use anyhow::{anyhow, Result};
use async_trait::async_trait;

#[async_trait]
pub trait SecretVault: Send + Sync {
    /// Get a symmetric key for encryption (e.g. for audit logs)
    async fn get_encryption_key(&self, key_id: &str) -> Result<Vec<u8>>;

    /// Sign data using an asymmetric key (e.g. for policy signatures)
    async fn sign_data(&self, key_id: &str, data: &[u8]) -> Result<Vec<u8>>;
}

/// Local vault that uses configuration-provided keys
pub struct LocalVault {
    encryption_key: Option<Vec<u8>>,
}

/// Length in bytes of a local vault key.
const LOCAL_KEY_LEN: usize = 32;

impl LocalVault {
    /// Build a local vault.
    ///
    /// `None` means no key is configured: the vault is created and
    /// `get_encryption_key` reports that no key is configured. `Some(key)`
    /// must be exactly 64 hex characters (32 bytes); anything else is an
    /// error, so a typo is never mistaken for "no key". The error never
    /// contains the key.
    pub fn new(encryption_key: Option<String>) -> Result<Self> {
        let key = match encryption_key {
            None => None,
            Some(k) => {
                let bytes = hex::decode(&k).map_err(|_| anyhow!("Vault key is not valid hex"))?;
                if bytes.len() != LOCAL_KEY_LEN {
                    return Err(anyhow!(
                        "Vault key must be {} bytes ({} hex characters), got {} bytes",
                        LOCAL_KEY_LEN,
                        LOCAL_KEY_LEN * 2,
                        bytes.len()
                    ));
                }
                Some(bytes)
            }
        };
        Ok(Self {
            encryption_key: key,
        })
    }
}

#[async_trait]
impl SecretVault for LocalVault {
    async fn get_encryption_key(&self, _key_id: &str) -> Result<Vec<u8>> {
        self.encryption_key
            .clone()
            .ok_or_else(|| anyhow!("Encryption key not configured in local vault"))
    }

    async fn sign_data(&self, _key_id: &str, _data: &[u8]) -> Result<Vec<u8>> {
        Err(anyhow!(
            "Asymmetric signing not yet implemented for local vault"
        ))
    }
}

pub use super::kms_vault::AwsKmsVault;

#[cfg(test)]
mod tests {
    use super::*;

    // Fake 32-byte key (hex of 0x00..0x1f); not a real secret.
    const FAKE_KEY_HEX: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    fn fake_key_bytes() -> Vec<u8> {
        (0u8..32).collect()
    }

    fn new_ok(key: &str) -> LocalVault {
        LocalVault::new(Some(key.to_string())).unwrap()
    }

    #[tokio::test]
    async fn local_vault_returns_decoded_key() {
        let vault = new_ok(FAKE_KEY_HEX);
        let key = vault.get_encryption_key("any").await.unwrap();
        assert_eq!(key, fake_key_bytes());
        assert_eq!(key.len(), 32);
    }

    #[tokio::test]
    async fn local_vault_accepts_uppercase_hex() {
        let vault = new_ok(&FAKE_KEY_HEX.to_uppercase());
        let key = vault.get_encryption_key("any").await.unwrap();
        assert_eq!(key, fake_key_bytes());
    }

    #[tokio::test]
    async fn local_vault_ignores_key_id() {
        let vault = new_ok(FAKE_KEY_HEX);
        let a = vault.get_encryption_key("audit").await.unwrap();
        let b = vault.get_encryption_key("").await.unwrap();
        assert_eq!(a, b);
    }

    #[tokio::test]
    async fn local_vault_returns_same_key_on_repeated_calls() {
        let vault = new_ok(FAKE_KEY_HEX);
        let first = vault.get_encryption_key("k").await.unwrap();
        let second = vault.get_encryption_key("k").await.unwrap();
        assert_eq!(first, second);
    }

    #[tokio::test]
    async fn local_vault_without_key_errors() {
        let vault = LocalVault::new(None).unwrap();
        let err = vault.get_encryption_key("k").await.unwrap_err();
        assert!(err.to_string().contains("not configured"));
    }

    #[test]
    fn local_vault_invalid_hex_is_rejected() {
        for bad in ["not-hex", "zz", "abc", "0g", " 00"] {
            let err = LocalVault::new(Some(bad.to_string())).err().unwrap();
            assert!(err.to_string().contains("not valid hex"), "{bad:?}");
        }
    }

    #[test]
    fn local_vault_odd_length_hex_is_rejected() {
        let key = FAKE_KEY_HEX[..FAKE_KEY_HEX.len() - 1].to_string();
        assert!(LocalVault::new(Some(key)).is_err());
    }

    #[test]
    fn local_vault_empty_string_is_rejected() {
        let err = LocalVault::new(Some(String::new())).err().unwrap();
        assert!(err.to_string().contains("32 bytes"));
    }

    #[test]
    fn local_vault_wrong_length_is_rejected() {
        for len in [1usize, 16, 31, 33, 64] {
            let key = "ab".repeat(len);
            assert!(LocalVault::new(Some(key)).is_err(), "{len} bytes");
        }
    }

    #[test]
    fn local_vault_does_not_trim_whitespace() {
        assert!(LocalVault::new(Some(format!(" {FAKE_KEY_HEX}"))).is_err());
    }

    #[test]
    fn local_vault_error_does_not_leak_the_key() {
        let secret = "deadbeefdeadbeef";
        let msg = LocalVault::new(Some(secret.to_string()))
            .err()
            .unwrap()
            .to_string();
        assert!(!msg.contains(secret));
        let msg = LocalVault::new(Some("zz-fake-secret".to_string()))
            .err()
            .unwrap()
            .to_string();
        assert!(!msg.contains("fake-secret"));
    }

    #[tokio::test]
    async fn local_vault_signing_is_not_implemented() {
        let with_key = new_ok(FAKE_KEY_HEX);
        let without_key = LocalVault::new(None).unwrap();
        for vault in [&with_key, &without_key] {
            let err = vault.sign_data("k", b"data").await.unwrap_err();
            assert!(err.to_string().contains("not yet implemented"));
            assert!(vault.sign_data("k", b"").await.is_err());
        }
    }

    #[tokio::test]
    async fn vault_is_usable_as_trait_object() {
        let vault: Box<dyn SecretVault> = Box::new(new_ok(FAKE_KEY_HEX));
        assert_eq!(
            vault.get_encryption_key("k").await.unwrap(),
            fake_key_bytes()
        );
    }
}
