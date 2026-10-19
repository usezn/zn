//! Secret Vault Abstraction
//!
//! Provides a unified interface for key management, supporting:
//! - Local (In-Memory/Config-based)
//! - HSM (via PKCS#11 - Placeholder)
//! - Cloud KMS (AWS KMS)

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use aws_config::BehaviorVersion;
use aws_sdk_kms as kms;

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

/// AWS KMS Vault implementation
pub struct AwsKmsVault {
    client: kms::Client,
}

impl AwsKmsVault {
    pub async fn new() -> Self {
        let config = aws_config::load_defaults(BehaviorVersion::latest()).await;
        let client = kms::Client::new(&config);
        Self { client }
    }
}

#[async_trait]
impl SecretVault for AwsKmsVault {
    async fn get_encryption_key(&self, key_id: &str) -> Result<Vec<u8>> {
        let resp = self
            .client
            .generate_data_key()
            .key_id(key_id)
            .key_spec(kms::types::DataKeySpec::Aes256)
            .send()
            .await
            .map_err(|e| anyhow!("AWS KMS error: {}", e))?;

        let blob = resp
            .plaintext
            .ok_or_else(|| anyhow!("KMS response missing plaintext key"))?;

        Ok(blob.into_inner())
    }

    async fn sign_data(&self, key_id: &str, data: &[u8]) -> Result<Vec<u8>> {
        use aws_sdk_kms::primitives::Blob;

        let resp = self
            .client
            .sign()
            .key_id(key_id)
            .message(Blob::new(data))
            .signing_algorithm(kms::types::SigningAlgorithmSpec::RsassaPssSha256)
            .send()
            .await
            .map_err(|e| anyhow!("AWS KMS signing error: {}", e))?;

        let signature = resp
            .signature
            .ok_or_else(|| anyhow!("KMS response missing signature"))?;

        Ok(signature.into_inner())
    }
}

#[cfg(test)]
mod strict_key_tests {
    use super::*;

    // Fake 32-byte key (hex of 0x00..0x1f); not a real secret.
    const FAKE_KEY_HEX: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    #[tokio::test]
    async fn accepts_exactly_32_bytes() {
        let vault = LocalVault::new(Some(FAKE_KEY_HEX.to_string())).unwrap();
        let key = vault.get_encryption_key("k").await.unwrap();
        assert_eq!(key, (0u8..32).collect::<Vec<u8>>());
    }

    #[tokio::test]
    async fn no_key_is_ok_and_reports_not_configured() {
        let vault = LocalVault::new(None).unwrap();
        let err = vault.get_encryption_key("k").await.unwrap_err();
        assert!(err.to_string().contains("not configured"));
    }

    #[test]
    fn empty_key_is_rejected() {
        let err = LocalVault::new(Some(String::new())).err().unwrap();
        assert!(err.to_string().contains("32 bytes"));
    }

    #[test]
    fn malformed_hex_is_rejected() {
        for bad in ["not-hex", "zz", "abc", "0g", " 00"] {
            let err = LocalVault::new(Some(bad.to_string())).err().unwrap();
            assert!(err.to_string().contains("not valid hex"), "{bad:?}");
        }
    }

    #[test]
    fn wrong_length_is_rejected() {
        for len in [1usize, 16, 31, 33, 64] {
            let key = "ab".repeat(len);
            assert!(LocalVault::new(Some(key)).is_err(), "{len} bytes");
        }
    }

    #[test]
    fn error_does_not_leak_the_key() {
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
}
