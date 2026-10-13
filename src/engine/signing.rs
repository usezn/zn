//! Policy Signing Module
//!
//! Handles Hybrid signature verification for WASM policies:
//! 1. Ed25519 (Classic)
//! 2. ML-DSA / Dilithium (Post-Quantum)
//!
//! Policies can have .wasm.sig (Ed25519) and/or .wasm.pqs (Post-Quantum) files.

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use pqcrypto_dilithium::dilithium3;
use pqcrypto_traits::sign::{DetachedSignature, PublicKey};
use std::path::Path;
use tracing::info;

pub struct PolicyVerifier {
    public_key: Option<VerifyingKey>,
    pq_public_key: Option<dilithium3::PublicKey>,
}

impl PolicyVerifier {
    /// Create a new PolicyVerifier with optional classic and PQ public keys
    pub fn new(public_key_hex: Option<&str>) -> Result<Self> {
        let public_key = if let Some(hex) = public_key_hex {
            let bytes = hex::decode(hex).map_err(|e| anyhow!("Invalid public key hex: {}", e))?;
            let key_bytes: [u8; 32] = bytes
                .try_into()
                .map_err(|_| anyhow!("Public key must be 32 bytes"))?;
            Some(VerifyingKey::from_bytes(&key_bytes)?)
        } else {
            None
        };

        // Try to load PQ key from environment if not explicitly provided
        let pq_key_hex = std::env::var("ZN_PQ_PUBLIC_KEY").ok();
        let pq_public_key = if let Some(hex) = pq_key_hex {
            let bytes =
                hex::decode(hex).map_err(|e| anyhow!("Invalid PQ public key hex: {}", e))?;
            Some(
                dilithium3::PublicKey::from_bytes(&bytes)
                    .map_err(|e| anyhow!("Invalid PQ public key format: {:?}", e))?,
            )
        } else {
            None
        };

        if pq_public_key.is_some() {
            info!("Post-Quantum Policy Verification enabled (Dilithium3)");
        }

        Ok(Self {
            public_key,
            pq_public_key,
        })
    }

    /// Verify a policy signature (Classic and/or PQ)
    pub fn verify(&self, wasm_bytes: &[u8], wasm_path: &Path) -> Result<()> {
        let mut verified_at_least_one = false;

        // 1. Verify Classic Signature (Ed25519)
        if let Some(pk) = &self.public_key {
            let sig_path = wasm_path.with_extension("wasm.sig");
            if !sig_path.exists() {
                return Err(anyhow!("Missing required signature file: {:?}", sig_path));
            }

            let sig_b64 = std::fs::read_to_string(&sig_path)
                .map_err(|e| anyhow!("Failed to read signature file: {}", e))?;

            let sig_bytes = general_purpose::STANDARD
                .decode(sig_b64.trim())
                .map_err(|e| anyhow!("Invalid signature base64: {}", e))?;

            let signature = Signature::from_slice(&sig_bytes)
                .map_err(|e| anyhow!("Invalid signature format: {}", e))?;

            pk.verify(wasm_bytes, &signature)
                .map_err(|_| anyhow!("Classic signature mismatch for policy"))?;

            info!("Classic signature (Ed25519) verified for {:?}", wasm_path);
            verified_at_least_one = true;
        }

        // 2. Verify Post-Quantum Signature (Dilithium3)
        if let Some(pq_pk) = &self.pq_public_key {
            let sig_path = wasm_path.with_extension("wasm.pqs");
            if !sig_path.exists() {
                // If PQ key is configured, PQ signature is MANDATORY
                return Err(anyhow!(
                    "Post-Quantum signature REQUIRED but missing: {:?}",
                    sig_path
                ));
            }

            let sig_b64 = std::fs::read_to_string(&sig_path)
                .map_err(|e| anyhow!("Failed to read PQ signature file: {}", e))?;

            let sig_bytes = general_purpose::STANDARD
                .decode(sig_b64.trim())
                .map_err(|e| anyhow!("Invalid PQ signature base64: {}", e))?;

            let signature = dilithium3::DetachedSignature::from_bytes(&sig_bytes)
                .map_err(|e| anyhow!("Invalid PQ signature format: {:?}", e))?;

            dilithium3::verify_detached_signature(&signature, wasm_bytes, pq_pk)
                .map_err(|_| anyhow!("Post-Quantum signature mismatch for policy"))?;

            info!(
                "Post-Quantum signature (ML-DSA/Dilithium3) verified for {:?}",
                wasm_path
            );
            verified_at_least_one = true;
        }

        if !verified_at_least_one && (self.public_key.is_some() || self.pq_public_key.is_some()) {
            return Err(anyhow!(
                "Policy signatures configured but verification failed"
            ));
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::PolicyVerifier;
    use std::path::{Path, PathBuf};

    // RFC 8032, section 7.1, TEST 2 (one-byte message 0x72).
    const PUBLIC_KEY_HEX: &str = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
    const MESSAGE: &[u8] = &[0x72];
    const SIGNATURE_B64: &str =
        "kqAJqfDUyrhyDoILX2QlQKKye1QWUD+Ps3YiI+vbadoIWsHkPhWZbkWPNhPQ8R2MOHsurrQwKu6wDSkWErsMAA==";
    // Same signature with the scalar S replaced by S + L (the group order):
    // a non-canonical encoding that must be rejected.
    const NON_CANONICAL_SIGNATURE_B64: &str =
        "kqAJqfDUyrhyDoILX2QlQKKye1QWUD+Ps3YiI+vbadr1LbdBWXirxhssLrau6/ygOHsurrQwKu6wDSkWErsMEA==";

    fn policy_with_signature(dir: &Path, signature_b64: Option<&str>) -> PathBuf {
        let wasm_path = dir.join("policy.wasm");
        std::fs::write(&wasm_path, MESSAGE).unwrap();
        if let Some(sig) = signature_b64 {
            std::fs::write(dir.join("policy.wasm.sig"), format!("{sig}\n")).unwrap();
        }
        wasm_path
    }

    fn verifier() -> PolicyVerifier {
        let v = PolicyVerifier::new(Some(PUBLIC_KEY_HEX)).unwrap();
        assert!(
            v.pq_public_key.is_none(),
            "these tests expect ZN_PQ_PUBLIC_KEY to be unset"
        );
        v
    }

    #[test]
    fn ed25519_accepts_rfc8032_signature() {
        let dir = tempfile::tempdir().unwrap();
        let wasm = policy_with_signature(dir.path(), Some(SIGNATURE_B64));
        verifier().verify(MESSAGE, &wasm).unwrap();
    }

    #[test]
    fn ed25519_rejects_modified_policy() {
        let dir = tempfile::tempdir().unwrap();
        let wasm = policy_with_signature(dir.path(), Some(SIGNATURE_B64));
        assert!(verifier().verify(&[0x73], &wasm).is_err());
    }

    #[test]
    fn ed25519_rejects_modified_signature() {
        let mut sig =
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, SIGNATURE_B64)
                .unwrap();
        sig[0] ^= 0x01;
        let tampered = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &sig);
        let dir = tempfile::tempdir().unwrap();
        let wasm = policy_with_signature(dir.path(), Some(&tampered));
        assert!(verifier().verify(MESSAGE, &wasm).is_err());
    }

    #[test]
    fn ed25519_rejects_non_canonical_scalar() {
        let dir = tempfile::tempdir().unwrap();
        let wasm = policy_with_signature(dir.path(), Some(NON_CANONICAL_SIGNATURE_B64));
        assert!(verifier().verify(MESSAGE, &wasm).is_err());
    }

    #[test]
    fn ed25519_rejects_wrong_length_signature() {
        let dir = tempfile::tempdir().unwrap();
        let wasm = policy_with_signature(dir.path(), Some("AAAA"));
        assert!(verifier().verify(MESSAGE, &wasm).is_err());
    }

    #[test]
    fn ed25519_requires_signature_file() {
        let dir = tempfile::tempdir().unwrap();
        let wasm = policy_with_signature(dir.path(), None);
        assert!(verifier().verify(MESSAGE, &wasm).is_err());
    }

    #[test]
    fn rejects_malformed_public_key() {
        assert!(PolicyVerifier::new(Some("00")).is_err());
        assert!(PolicyVerifier::new(Some("not hex")).is_err());
    }
}
