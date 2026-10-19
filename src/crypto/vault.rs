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

impl LocalVault {
    pub fn new(encryption_key: Option<String>) -> Self {
        let key = encryption_key.and_then(|k| hex::decode(k).ok());
        Self {
            encryption_key: key,
        }
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
mod tests {
    use super::*;

    // Fake 32-byte key (hex of 0x00..0x1f); not a real secret.
    const FAKE_KEY_HEX: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    fn fake_key_bytes() -> Vec<u8> {
        (0u8..32).collect()
    }

    #[tokio::test]
    async fn local_vault_returns_decoded_key() {
        let vault = LocalVault::new(Some(FAKE_KEY_HEX.to_string()));
        let key = vault.get_encryption_key("any").await.unwrap();
        assert_eq!(key, fake_key_bytes());
        assert_eq!(key.len(), 32);
    }

    #[tokio::test]
    async fn local_vault_accepts_uppercase_hex() {
        let vault = LocalVault::new(Some(FAKE_KEY_HEX.to_uppercase()));
        let key = vault.get_encryption_key("any").await.unwrap();
        assert_eq!(key, fake_key_bytes());
    }

    #[tokio::test]
    async fn local_vault_ignores_key_id() {
        let vault = LocalVault::new(Some(FAKE_KEY_HEX.to_string()));
        let a = vault.get_encryption_key("audit").await.unwrap();
        let b = vault.get_encryption_key("").await.unwrap();
        assert_eq!(a, b);
    }

    #[tokio::test]
    async fn local_vault_returns_same_key_on_repeated_calls() {
        let vault = LocalVault::new(Some(FAKE_KEY_HEX.to_string()));
        let first = vault.get_encryption_key("k").await.unwrap();
        let second = vault.get_encryption_key("k").await.unwrap();
        assert_eq!(first, second);
    }

    #[tokio::test]
    async fn local_vault_without_key_errors() {
        let vault = LocalVault::new(None);
        let err = vault.get_encryption_key("k").await.unwrap_err();
        assert!(err.to_string().contains("not configured"));
    }

    #[tokio::test]
    async fn local_vault_invalid_hex_is_treated_as_missing() {
        for bad in ["not-hex", "zz", "abc", "0g"] {
            let vault = LocalVault::new(Some(bad.to_string()));
            assert!(
                vault.get_encryption_key("k").await.is_err(),
                "input {bad:?} must not produce a key"
            );
        }
    }

    #[tokio::test]
    async fn local_vault_odd_length_hex_is_rejected() {
        let vault = LocalVault::new(Some(FAKE_KEY_HEX[..FAKE_KEY_HEX.len() - 1].to_string()));
        assert!(vault.get_encryption_key("k").await.is_err());
    }

    #[tokio::test]
    async fn local_vault_empty_string_yields_empty_key() {
        // hex::decode("") is Ok(empty), so the vault reports a zero-length key.
        // Callers must validate the key length themselves.
        let vault = LocalVault::new(Some(String::new()));
        let key = vault.get_encryption_key("k").await.unwrap();
        assert!(key.is_empty());
    }

    #[tokio::test]
    async fn local_vault_does_not_trim_whitespace() {
        let vault = LocalVault::new(Some(format!(" {FAKE_KEY_HEX}")));
        assert!(vault.get_encryption_key("k").await.is_err());
    }

    #[tokio::test]
    async fn local_vault_signing_is_not_implemented() {
        let with_key = LocalVault::new(Some(FAKE_KEY_HEX.to_string()));
        let without_key = LocalVault::new(None);
        for vault in [&with_key, &without_key] {
            let err = vault.sign_data("k", b"data").await.unwrap_err();
            assert!(err.to_string().contains("not yet implemented"));
            assert!(vault.sign_data("k", b"").await.is_err());
        }
    }

    #[tokio::test]
    async fn vault_is_usable_as_trait_object() {
        let vault: Box<dyn SecretVault> = Box::new(LocalVault::new(Some(FAKE_KEY_HEX.to_string())));
        assert_eq!(
            vault.get_encryption_key("k").await.unwrap(),
            fake_key_bytes()
        );
    }
}
