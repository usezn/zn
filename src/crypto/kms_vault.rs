//! AWS KMS vault with a persistent data key.
//!
//! The audit database key is a KMS data key. It is created once with
//! `GenerateDataKey`; only the encrypted copy (`CiphertextBlob`) is written
//! to a state file next to the audit database. On every later start the blob
//! is read and sent to KMS `Decrypt`, so the same key comes back and records
//! written before a restart stay readable. The plaintext key lives in memory
//! only.
//!
//! The vault never creates a new key when it should find the old one: a
//! damaged blob, a failed `Decrypt` or a changed `kms.key_id` stops the start
//! with an error. Setting `ZN_KMS_RECOVER_NEW_DATA_KEY=true` for one start
//! replaces the blob with a new key (earlier encrypted records are lost).

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use aws_config::BehaviorVersion;
use aws_sdk_kms as kms;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::vault::SecretVault;

/// Encryption context bound to the data key. KMS requires the same context
/// on `Decrypt`, so the blob cannot be used for anything else.
pub const KMS_CONTEXT_KEY: &str = "purpose";
pub const KMS_CONTEXT_VALUE: &str = "zn-gate-audit-db-key";

/// Name of the state file, placed in the directory of the audit database.
pub const DATA_KEY_FILE_NAME: &str = "zn-kms-data-key.json";

/// Environment variable that allows one start with a new data key.
pub const RECOVER_ENV: &str = "ZN_KMS_RECOVER_NEW_DATA_KEY";

const DATA_KEY_LEN: usize = 32;
const STATE_VERSION: u32 = 1;

/// Path of the data key state file for a given audit database path.
pub fn data_key_file_for(db_path: impl AsRef<Path>) -> PathBuf {
    db_path.as_ref().with_file_name(DATA_KEY_FILE_NAME)
}

/// True when `ZN_KMS_RECOVER_NEW_DATA_KEY` is set to `true` or `1`.
pub fn recover_flag_from_env() -> bool {
    matches!(
        std::env::var(RECOVER_ENV)
            .map(|v| v.trim().to_ascii_lowercase())
            .as_deref(),
        Ok("true") | Ok("1")
    )
}

/// A new data key: the plaintext (memory only) and its encrypted copy.
pub struct GeneratedKey {
    pub plaintext: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

/// The KMS calls the vault needs. A fake implements it in tests.
#[async_trait]
pub trait KmsApi: Send + Sync {
    async fn generate_data_key(&self, key_id: &str, context: (&str, &str)) -> Result<GeneratedKey>;
    async fn decrypt(
        &self,
        key_id: &str,
        ciphertext: &[u8],
        context: (&str, &str),
    ) -> Result<Vec<u8>>;
    async fn sign(&self, key_id: &str, data: &[u8]) -> Result<Vec<u8>>;
}

/// The real client.
pub struct AwsKmsApi {
    client: kms::Client,
}

impl AwsKmsApi {
    pub async fn new() -> Self {
        let config = aws_config::load_defaults(BehaviorVersion::latest()).await;
        Self {
            client: kms::Client::new(&config),
        }
    }
}

#[async_trait]
impl KmsApi for AwsKmsApi {
    async fn generate_data_key(&self, key_id: &str, context: (&str, &str)) -> Result<GeneratedKey> {
        let resp = self
            .client
            .generate_data_key()
            .key_id(key_id)
            .key_spec(kms::types::DataKeySpec::Aes256)
            .encryption_context(context.0, context.1)
            .send()
            .await
            .map_err(|e| anyhow!("AWS KMS GenerateDataKey error: {}", e))?;
        let plaintext = resp
            .plaintext
            .ok_or_else(|| anyhow!("KMS response missing plaintext key"))?
            .into_inner();
        let ciphertext = resp
            .ciphertext_blob
            .ok_or_else(|| anyhow!("KMS response missing encrypted key"))?
            .into_inner();
        Ok(GeneratedKey {
            plaintext,
            ciphertext,
        })
    }

    async fn decrypt(
        &self,
        key_id: &str,
        ciphertext: &[u8],
        context: (&str, &str),
    ) -> Result<Vec<u8>> {
        use aws_sdk_kms::primitives::Blob;
        let resp = self
            .client
            .decrypt()
            .key_id(key_id)
            .ciphertext_blob(Blob::new(ciphertext))
            .encryption_context(context.0, context.1)
            .send()
            .await
            .map_err(|e| anyhow!("AWS KMS Decrypt error: {}", e))?;
        Ok(resp
            .plaintext
            .ok_or_else(|| anyhow!("KMS response missing plaintext key"))?
            .into_inner())
    }

    async fn sign(&self, key_id: &str, data: &[u8]) -> Result<Vec<u8>> {
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
        Ok(resp
            .signature
            .ok_or_else(|| anyhow!("KMS response missing signature"))?
            .into_inner())
    }
}

/// Contents of the state file. It holds no secret: the data key is encrypted
/// under the KMS key.
#[derive(Serialize, Deserialize)]
struct DataKeyState {
    version: u32,
    key_id: String,
    ciphertext_b64: String,
}

/// AWS KMS vault implementation.
pub struct AwsKmsVault {
    api: Box<dyn KmsApi>,
    state_path: PathBuf,
    recover_new_key: bool,
    // Serialises the first-start "generate and persist" step.
    lock: Mutex<()>,
}

impl AwsKmsVault {
    /// Real KMS client. `state_path` is the data key file (see
    /// [`data_key_file_for`]); `recover_new_key` is the explicit recovery flag.
    pub async fn new(state_path: PathBuf, recover_new_key: bool) -> Self {
        Self::with_api(
            Box::new(AwsKmsApi::new().await),
            state_path,
            recover_new_key,
        )
    }

    pub fn with_api(api: Box<dyn KmsApi>, state_path: PathBuf, recover_new_key: bool) -> Self {
        Self {
            api,
            state_path,
            recover_new_key,
            lock: Mutex::new(()),
        }
    }

    async fn create_and_persist(&self, key_id: &str, overwrite: bool) -> Result<Vec<u8>> {
        let generated = self
            .api
            .generate_data_key(key_id, (KMS_CONTEXT_KEY, KMS_CONTEXT_VALUE))
            .await?;
        check_len(&generated.plaintext)?;
        let state = DataKeyState {
            version: STATE_VERSION,
            key_id: key_id.to_string(),
            ciphertext_b64: STANDARD.encode(&generated.ciphertext),
        };
        // If the blob cannot be saved the key is not used: data written with
        // it could never be read again.
        write_state(&self.state_path, &state, overwrite)?;
        Ok(generated.plaintext)
    }
}

fn check_len(key: &[u8]) -> Result<()> {
    if key.len() != DATA_KEY_LEN {
        return Err(anyhow!(
            "KMS returned a data key of {} bytes, expected {}",
            key.len(),
            DATA_KEY_LEN
        ));
    }
    Ok(())
}

fn recovery_hint() -> String {
    format!(
        "To start with a new key anyway (earlier encrypted records are lost), set {}=true for one start.",
        RECOVER_ENV
    )
}

fn read_state(raw: &[u8]) -> std::result::Result<(DataKeyState, Vec<u8>), String> {
    let state: DataKeyState = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    if state.version != STATE_VERSION {
        return Err(format!("unsupported version {}", state.version));
    }
    let blob = STANDARD
        .decode(&state.ciphertext_b64)
        .map_err(|e| e.to_string())?;
    if blob.is_empty() {
        return Err("empty encrypted key".to_string());
    }
    Ok((state, blob))
}

#[async_trait]
impl SecretVault for AwsKmsVault {
    async fn get_encryption_key(&self, key_id: &str) -> Result<Vec<u8>> {
        let _guard = self.lock.lock().await;
        let path = &self.state_path;

        let raw = match std::fs::read(path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // First start (or a deliberate fresh state directory).
                return self.create_and_persist(key_id, false).await;
            }
            Err(e) => {
                return Err(anyhow!(
                    "Cannot read the KMS data key file {:?}: {}",
                    path,
                    e
                ))
            }
        };

        let (state, blob) = match read_state(&raw) {
            Ok(v) => v,
            Err(why) => {
                if self.recover_new_key {
                    tracing::warn!(
                        "KMS data key file {:?} is damaged ({}); creating a new key because {} is set",
                        path,
                        why,
                        RECOVER_ENV
                    );
                    return self.create_and_persist(key_id, true).await;
                }
                return Err(anyhow!(
                    "The KMS data key file {:?} is damaged ({}). Refusing to start with a new key. {}",
                    path,
                    why,
                    recovery_hint()
                ));
            }
        };

        if state.key_id != key_id {
            if self.recover_new_key {
                tracing::warn!(
                    "kms.key_id changed; creating a new data key because {} is set",
                    RECOVER_ENV
                );
                return self.create_and_persist(key_id, true).await;
            }
            return Err(anyhow!(
                "kms.key_id does not match the key that protects {:?} (stored: {}, configured: {}). \
                 Refusing to start: a new key would make earlier audit records unreadable. \
                 Set kms.key_id back to the stored value. {}",
                path,
                state.key_id,
                key_id,
                recovery_hint()
            ));
        }

        match self
            .api
            .decrypt(key_id, &blob, (KMS_CONTEXT_KEY, KMS_CONTEXT_VALUE))
            .await
        {
            Ok(plain) => {
                check_len(&plain)?;
                Ok(plain)
            }
            Err(e) => {
                if self.recover_new_key {
                    tracing::warn!(
                        "KMS Decrypt failed ({}); creating a new data key because {} is set",
                        e,
                        RECOVER_ENV
                    );
                    return self.create_and_persist(key_id, true).await;
                }
                Err(anyhow!(
                    "KMS could not decrypt the stored data key in {:?}: {}. \
                     Refusing to start with a new key. Check the AWS credentials, the region and the \
                     permissions on the KMS key, then retry. {}",
                    path,
                    e,
                    recovery_hint()
                ))
            }
        }
    }

    async fn sign_data(&self, key_id: &str, data: &[u8]) -> Result<Vec<u8>> {
        self.api.sign(key_id, data).await
    }
}

/// Writes the state file atomically with mode 0600 on Unix: a temporary file
/// in the same directory is written and synced, then moved into place. With
/// `overwrite == false` an existing file is never replaced.
fn write_state(path: &Path, state: &DataKeyState, overwrite: bool) -> Result<()> {
    use std::io::Write;
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    std::fs::create_dir_all(&dir)
        .map_err(|e| anyhow!("Failed to create directory {:?}: {}", dir, e))?;
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        DATA_KEY_FILE_NAME,
        std::process::id()
    ));
    let _ = std::fs::remove_file(&tmp);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut body = serde_json::to_vec_pretty(state)?;
    body.push(b'\n');
    let result = (|| -> Result<()> {
        let mut f = opts
            .open(&tmp)
            .map_err(|e| anyhow!("Failed to create {:?}: {}", tmp, e))?;
        f.write_all(&body)
            .and_then(|_| f.sync_all())
            .map_err(|e| anyhow!("Failed to write {:?}: {}", tmp, e))?;
        if overwrite {
            std::fs::rename(&tmp, path)
        } else {
            // Fails if the file appeared in the meantime.
            std::fs::hard_link(&tmp, path)
        }
        .map_err(|e| anyhow!("Failed to save the KMS data key file {:?}: {}", path, e))?;
        #[cfg(unix)]
        if let Ok(d) = std::fs::File::open(&dir) {
            let _ = d.sync_all();
        }
        Ok(())
    })();
    let _ = std::fs::remove_file(&tmp);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
    use std::sync::Arc;

    /// Fake KMS: "encrypts" by prefixing the key id and reversing the key.
    /// Counts calls so tests can tell generate from decrypt.
    #[derive(Default)]
    struct FakeKms {
        generated: AtomicU8,
        decrypted: AtomicU8,
        fail_decrypt: AtomicBool,
    }

    #[async_trait]
    impl KmsApi for Arc<FakeKms> {
        async fn generate_data_key(&self, key_id: &str, ctx: (&str, &str)) -> Result<GeneratedKey> {
            assert_eq!(ctx, (KMS_CONTEXT_KEY, KMS_CONTEXT_VALUE));
            let n = self.generated.fetch_add(1, Ordering::SeqCst) + 1;
            let plaintext = vec![n; 32];
            let mut ciphertext = key_id.as_bytes().to_vec();
            ciphertext.extend(plaintext.iter().rev());
            Ok(GeneratedKey {
                plaintext,
                ciphertext,
            })
        }
        async fn decrypt(&self, key_id: &str, ct: &[u8], ctx: (&str, &str)) -> Result<Vec<u8>> {
            assert_eq!(ctx, (KMS_CONTEXT_KEY, KMS_CONTEXT_VALUE));
            self.decrypted.fetch_add(1, Ordering::SeqCst);
            if self.fail_decrypt.load(Ordering::SeqCst) {
                return Err(anyhow!("AccessDenied"));
            }
            let rest = ct
                .strip_prefix(key_id.as_bytes())
                .ok_or_else(|| anyhow!("InvalidCiphertext"))?;
            if rest.len() != 32 {
                return Err(anyhow!("InvalidCiphertext"));
            }
            Ok(rest.iter().rev().copied().collect())
        }
        async fn sign(&self, _key_id: &str, _data: &[u8]) -> Result<Vec<u8>> {
            Ok(vec![1, 2, 3])
        }
    }

    fn vault(kms: &Arc<FakeKms>, path: &Path, recover: bool) -> AwsKmsVault {
        AwsKmsVault::with_api(Box::new(kms.clone()), path.to_path_buf(), recover)
    }

    fn garbage_state(key_id: &str) -> DataKeyState {
        DataKeyState {
            version: STATE_VERSION,
            key_id: key_id.into(),
            ciphertext_b64: STANDARD.encode(b"garbage"),
        }
    }

    #[tokio::test]
    async fn first_start_generates_and_persists_only_the_encrypted_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = data_key_file_for(dir.path().join("audit.db"));
        let kms = Arc::new(FakeKms::default());
        let key = vault(&kms, &path, false)
            .get_encryption_key("key-a")
            .await
            .unwrap();
        assert_eq!(key, vec![1u8; 32]);
        let text = std::fs::read_to_string(&path).unwrap();
        // The plaintext key must not be in the file in any common encoding.
        assert!(!text.contains(&hex::encode(&key)));
        assert!(!text.contains(&STANDARD.encode(&key)));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // No temporary file left behind.
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec![DATA_KEY_FILE_NAME.to_string()]);
    }

    #[tokio::test]
    async fn restart_returns_the_same_key_without_generating() {
        let dir = tempfile::tempdir().unwrap();
        let path = data_key_file_for(dir.path().join("audit.db"));
        let kms = Arc::new(FakeKms::default());
        let first = vault(&kms, &path, false)
            .get_encryption_key("key-a")
            .await
            .unwrap();
        // "Restart": a new vault instance on the same state file.
        let second = vault(&kms, &path, false)
            .get_encryption_key("key-a")
            .await
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(kms.generated.load(Ordering::SeqCst), 1);
        assert_eq!(kms.decrypted.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn audit_entries_survive_a_restart() {
        use crate::audit::{AuditEntry, AuditVault};
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("audit.db");
        let db_str = db.to_str().unwrap();
        let path = data_key_file_for(&db);
        let kms = Arc::new(FakeKms::default());

        let key1 = hex::encode(
            vault(&kms, &path, false)
                .get_encryption_key("key-a")
                .await
                .unwrap(),
        );
        {
            let audit = AuditVault::new(db_str, Some(&key1)).unwrap();
            audit
                .log(
                    AuditEntry::new("TOOL_CALL", "read_file", "ALLOWED")
                        .with_payload("written before the restart"),
                )
                .unwrap();
        }
        // Restart: a new vault instance and a new audit vault on the same files.
        let key2 = hex::encode(
            vault(&kms, &path, false)
                .get_encryption_key("key-a")
                .await
                .unwrap(),
        );
        assert_eq!(key1, key2);
        let audit = AuditVault::new(db_str, Some(&key2)).unwrap();
        let entries = audit.get_recent(10).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].payload.as_deref(),
            Some("written before the restart")
        );
    }

    #[tokio::test]
    async fn corrupt_blob_fails_closed_and_keeps_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = data_key_file_for(dir.path().join("audit.db"));
        let kms = Arc::new(FakeKms::default());
        vault(&kms, &path, false)
            .get_encryption_key("key-a")
            .await
            .unwrap();
        for bad in [
            "not json",
            "{}",
            r#"{"version":1,"key_id":"key-a","ciphertext_b64":"!!"}"#,
            r#"{"version":1,"key_id":"key-a","ciphertext_b64":""}"#,
            r#"{"version":9,"key_id":"key-a","ciphertext_b64":"AAAA"}"#,
        ] {
            std::fs::write(&path, bad).unwrap();
            let err = vault(&kms, &path, false)
                .get_encryption_key("key-a")
                .await
                .unwrap_err()
                .to_string();
            assert!(err.contains("damaged"), "{err}");
            assert!(err.contains(RECOVER_ENV));
            assert_eq!(std::fs::read_to_string(&path).unwrap(), bad);
        }
        assert_eq!(kms.generated.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn garbled_ciphertext_fails_decrypt_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = data_key_file_for(dir.path().join("audit.db"));
        let kms = Arc::new(FakeKms::default());
        write_state(&path, &garbage_state("key-a"), false).unwrap();
        let err = vault(&kms, &path, false)
            .get_encryption_key("key-a")
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("could not decrypt"), "{err}");
        assert_eq!(kms.generated.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn decrypt_failure_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = data_key_file_for(dir.path().join("audit.db"));
        let kms = Arc::new(FakeKms::default());
        vault(&kms, &path, false)
            .get_encryption_key("key-a")
            .await
            .unwrap();
        kms.fail_decrypt.store(true, Ordering::SeqCst);
        let before = std::fs::read(&path).unwrap();
        let err = vault(&kms, &path, false)
            .get_encryption_key("key-a")
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("could not decrypt"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(kms.generated.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn key_id_mismatch_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = data_key_file_for(dir.path().join("audit.db"));
        let kms = Arc::new(FakeKms::default());
        vault(&kms, &path, false)
            .get_encryption_key("key-a")
            .await
            .unwrap();
        let before = std::fs::read(&path).unwrap();
        let err = vault(&kms, &path, false)
            .get_encryption_key("key-b")
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("key-a") && err.contains("key-b"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(kms.generated.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn recovery_flag_replaces_the_key_in_every_failure_case() {
        let dir = tempfile::tempdir().unwrap();
        let path = data_key_file_for(dir.path().join("audit.db"));
        let kms = Arc::new(FakeKms::default());
        let old = vault(&kms, &path, false)
            .get_encryption_key("key-a")
            .await
            .unwrap();

        // Key id changed.
        let k2 = vault(&kms, &path, true)
            .get_encryption_key("key-b")
            .await
            .unwrap();
        assert_ne!(old, k2);
        // The new key is now the persistent one.
        let again = vault(&kms, &path, false)
            .get_encryption_key("key-b")
            .await
            .unwrap();
        assert_eq!(k2, again);

        // Corrupt file.
        std::fs::write(&path, "junk").unwrap();
        let k3 = vault(&kms, &path, true)
            .get_encryption_key("key-b")
            .await
            .unwrap();
        assert_ne!(k2, k3);

        // Decrypt failure.
        write_state(&path, &garbage_state("key-b"), true).unwrap();
        let k4 = vault(&kms, &path, true)
            .get_encryption_key("key-b")
            .await
            .unwrap();
        assert_ne!(k3, k4);
    }

    #[tokio::test]
    async fn unusable_state_path_means_no_key() {
        let dir = tempfile::tempdir().unwrap();
        // A directory where the file should be: it cannot be read as a file.
        let path = dir.path().join(DATA_KEY_FILE_NAME);
        std::fs::create_dir(&path).unwrap();
        let kms = Arc::new(FakeKms::default());
        assert!(vault(&kms, &path, false)
            .get_encryption_key("key-a")
            .await
            .is_err());
    }
}
