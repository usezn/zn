pub mod backend;
pub mod canary;
pub mod embedder;
pub mod memory;
pub mod registry;

// Re-export key types
pub use backend::{CandleBert, FastBootBackend, Head, OnnxModel};
pub use canary::{CanaryDeployer, CanaryStats};
pub use embedder::{Embedder, Embedding};
pub use memory::{MemoryError, VectorMemory};
pub use registry::{ModelEntry, ModelRegistry};

/// Pluggable inference backend for the neural core.
///
/// `embed()` is the shared path (memory + anomaly). `classify()` returns the
/// attack probability when the model carries a `head.json` (published by
/// `ml/train.py`), or `None` in anomaly-only mode.
pub trait ModelBackend: Send + Sync {
    fn embed(&self, text: &str) -> anyhow::Result<Vec<f32>>;
    fn classify(&self, vec: &[f32]) -> anyhow::Result<Option<f32>>;
    fn name(&self) -> &str;
    fn dim(&self) -> usize;
}

/// Fused System-2 decision: fire when the anomaly distance crosses
/// `threshold` OR the classifier probability crosses `classifier_threshold`.
/// `prob = None` is anomaly-only mode (no `head.json`), where the classifier
/// term is skipped and the decision is exactly the legacy anomaly rule.
pub fn neural_fired(
    distance: f32,
    threshold: f32,
    prob: Option<f32>,
    classifier_threshold: f32,
) -> bool {
    distance > threshold || prob.is_some_and(|p| p >= classifier_threshold)
}

/// Fused System-2 risk in `[0, 1]`: the max of the normalized anomaly signal
/// (0 at `threshold`, 1 at 2x `threshold`) and the classifier probability.
/// `prob = None` is anomaly-only mode. Used for logging/audit, not the
/// decision (see `neural_fired`).
pub fn fused_risk(distance: f32, threshold: f32, prob: Option<f32>) -> f32 {
    let anomaly = if threshold > 0.0 {
        ((distance - threshold) / threshold).clamp(0.0, 1.0)
    } else {
        distance.clamp(0.0, 1.0)
    };
    prob.map_or(anomaly, |p| anomaly.max(p))
}

/// HMAC-SHA256 (RFC 2104), written out so that no extra crate is needed.
fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        let d = Sha256::digest(key);
        k[..32].copy_from_slice(&d[..]);
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(k.map(|b| b ^ 0x36));
    inner.update(msg);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(k.map(|b| b ^ 0x5c));
    outer.update(&inner[..]);
    let mut out = [0u8; 32];
    out.copy_from_slice(&outer.finalize()[..]);
    out
}

static REF_KEY: std::sync::OnceLock<[u8; 32]> = std::sync::OnceLock::new();

/// Read the 32-byte reference key stored as `ref.key` in `dir`, creating it
/// (random, owner-only from the moment it exists) when it does not exist yet.
/// An existing key is refused unless it is a regular file, not a link, that
/// only this user can use; the checks run on the opened file. A key of the
/// wrong length (a crash while it was written) is never used: a new key
/// replaces it, with a warning.
pub fn load_or_create_ref_key(dir: &std::path::Path) -> std::io::Result<[u8; 32]> {
    let (key, regenerated) = load_ref_key(dir)?;
    if regenerated {
        tracing::warn!(
            "{}",
            concat!(
                "ref.key did not hold a valid key and was replaced by a new one. ",
                "References (h:...) already stored in the audit log and the vector memory ",
                "stay as they are, but they will not match the references of new calls."
            )
        );
    }
    Ok(key)
}

/// Returns the key and whether a new one replaced a file of the wrong length.
fn load_ref_key(dir: &std::path::Path) -> std::io::Result<([u8; 32], bool)> {
    use crate::private_file::{create_private_file_new, read_private_file};
    use std::io::{Error, ErrorKind};
    let path = dir.join("ref.key");
    let new_key = || {
        use rand::Rng;
        let mut key = [0u8; 32];
        rand::rng().fill_bytes(&mut key);
        key
    };
    std::fs::create_dir_all(dir)?;
    check_key_dir(dir)?;
    let existing = match read_private_file(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            let key = new_key();
            match create_private_file_new(&path, &key) {
                Ok(()) => return Ok((key, false)),
                Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                    read_private_file(&path).map_err(refuse)?
                }
                Err(e) => return Err(e),
            }
        }
        Err(e) => return Err(refuse(e)),
    };
    fn refuse(e: Error) -> Error {
        Error::new(
            e.kind(),
            format!("ref.key cannot be used (it must be a regular file that only this user can access): {e}"),
        )
    }
    match <[u8; 32]>::try_from(existing.as_slice()) {
        Ok(key) => Ok((key, false)),
        Err(_) => replace_bad_key(dir, &path),
    }
}

/// A file that was already there with the wrong length. Replacing it is done
/// under an exclusive lock file so two processes that find the same bad key
/// cannot each write a different one: the first takes the lock and writes, the
/// others wait for it and use the key that is on disk.
fn replace_bad_key(
    dir: &std::path::Path,
    path: &std::path::Path,
) -> std::io::Result<([u8; 32], bool)> {
    use crate::private_file::{create_private_file_new, read_private_file};
    use std::io::ErrorKind;
    let lock = dir.join("ref.key.lock");
    loop {
        match create_private_file_new(&lock, std::process::id().to_string().as_bytes()) {
            Ok(()) => {
                let result = replace_bad_key_locked(path);
                let _ = std::fs::remove_file(&lock);
                return result;
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                // The holder died without removing it: ignore the lock.
                let stale = std::fs::metadata(&lock)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age > REF_KEY_LOCK_STALE);
                if stale {
                    let _ = std::fs::remove_file(&lock);
                    continue;
                }
                // Somebody else is replacing the key: use theirs once it is there.
                if let Ok(bytes) = read_private_file(path) {
                    if let Ok(key) = <[u8; 32]>::try_from(bytes.as_slice()) {
                        return Ok((key, false));
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(e) => return Err(e),
        }
    }
}

/// With the lock held: re-read first (another process may have fixed the file
/// between our read and the lock), otherwise write a new key, and always return
/// what is on disk afterwards.
fn replace_bad_key_locked(path: &std::path::Path) -> std::io::Result<([u8; 32], bool)> {
    use crate::private_file::{create_private_file, read_private_file};
    use rand::Rng;
    use std::io::{Error, ErrorKind};
    let invalid = || Error::new(ErrorKind::InvalidData, "ref.key still has the wrong length");
    match read_private_file(path) {
        Ok(bytes) => {
            if let Ok(key) = <[u8; 32]>::try_from(bytes.as_slice()) {
                return Ok((key, false));
            }
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let mut fresh = [0u8; 32];
    rand::rng().fill_bytes(&mut fresh);
    create_private_file(path, &fresh)?;
    let on_disk = read_private_file(path)?;
    let key = <[u8; 32]>::try_from(on_disk.as_slice()).map_err(|_| invalid())?;
    Ok((key, true))
}

/// A lock file older than this belongs to a process that is gone.
const REF_KEY_LOCK_STALE: std::time::Duration = std::time::Duration::from_secs(30);

/// The folder that holds `ref.key` must be a real folder (not a link) owned by
/// the effective user that nobody else can write to; otherwise another user
/// could swap the key file or plant a lock. Fails closed.
fn check_key_dir(dir: &std::path::Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::{Error, ErrorKind};
        use std::os::unix::fs::MetadataExt;
        let refuse = |kind, why: &str| {
            Error::new(
                kind,
                format!(
                    "ref.key cannot be used: its folder {} {why}; it must be a real folder owned by this user that group and others cannot write to",
                    dir.display()
                ),
            )
        };
        let meta = std::fs::symlink_metadata(dir)?;
        if meta.file_type().is_symlink() {
            return Err(refuse(ErrorKind::InvalidInput, "is a symbolic link"));
        }
        if !meta.is_dir() {
            return Err(refuse(ErrorKind::InvalidInput, "is not a folder"));
        }
        // SAFETY: geteuid has no preconditions and cannot fail.
        if meta.uid() != unsafe { libc::geteuid() } {
            return Err(refuse(
                ErrorKind::PermissionDenied,
                "belongs to another user",
            ));
        }
        if meta.mode() & 0o022 != 0 {
            return Err(refuse(
                ErrorKind::PermissionDenied,
                "is writable by group or others",
            ));
        }
    }
    // Windows: the folder ACL check belongs to the private_file module.
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

/// Load (or create) the local reference key in `dir` and use it for every
/// `content_ref` of this process. Call it once at start, before anything is
/// written to the audit log or the vector memory.
pub fn init_ref_key(dir: &std::path::Path) -> std::io::Result<()> {
    let key = load_or_create_ref_key(dir)?;
    // Temporary files of an interrupted key write; failures do not matter.
    let _ = crate::private_file::remove_stale_temp_files(dir);
    match REF_KEY.set(key) {
        Ok(()) => Ok(()),
        Err(_) if REF_KEY.get() == Some(&key) => Ok(()),
        Err(_) => Err(std::io::Error::other(
            "the reference key was already set to a different value",
        )),
    }
}

fn ref_key() -> &'static [u8; 32] {
    // Without `init_ref_key` the key is random for this process only: refs
    // stay unlinkable to the text, they just do not match across restarts.
    REF_KEY.get_or_init(|| {
        use rand::Rng;
        let mut k = [0u8; 32];
        rand::rng().fill_bytes(&mut k);
        k
    })
}

/// True when `text` already has the shape of a reference (`h:` and 16
/// lowercase hex characters, exactly what `content_ref` writes).
pub fn is_content_ref(text: &str) -> bool {
    text.len() == 18
        && text.starts_with("h:")
        && text[2..]
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Reference to a piece of text under an explicit key.
pub fn content_ref_with_key(key: &[u8; 32], text: &str) -> String {
    if is_content_ref(text) {
        return text.to_string();
    }
    let mac = hmac_sha256(key, text.as_bytes());
    format!("h:{}", hex::encode(&mac[..8]))
}

/// Content-free reference to a piece of text: `h:` plus the first 16 hex
/// characters of its HMAC-SHA256 under a random key kept on this machine
/// (`ref.key`, see `init_ref_key`). The key keeps short or guessable values
/// (PINs, codes, IDs) from being recovered by hashing candidates. The vector
/// memory keeps this instead of the text of a call (the vector alone gives the
/// distance), and the audit log and the logs name a nearest neighbour only by
/// this reference. A value that already is a reference is returned unchanged,
/// so rows written by earlier versions (which hold raw text) are turned into a
/// reference on the way out.
pub fn content_ref(text: &str) -> String {
    content_ref_with_key(ref_key(), text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fired_matches_legacy_anomaly_only_when_no_head() {
        assert!(
            neural_fired(1.3, 1.2, None, 0.5),
            "above threshold must fire"
        );
        assert!(
            !neural_fired(1.1, 1.2, None, 0.5),
            "below threshold must not fire"
        );
        assert!(
            !neural_fired(0.0, 1.2, None, 0.5),
            "empty memory (d=0) must not fire"
        );
    }

    #[test]
    fn classifier_fires_without_anomaly() {
        // Regression: a known attack close to stored vectors (quiet anomaly)
        // but high classifier probability must still fire.
        assert!(neural_fired(0.2, 1.2, Some(0.9), 0.5));
        assert!(!neural_fired(0.2, 1.2, Some(0.4), 0.5));
        assert!(
            neural_fired(0.2, 1.2, Some(0.5), 0.5),
            "classifier threshold is inclusive"
        );
    }

    #[test]
    fn either_signal_fires() {
        assert!(
            neural_fired(1.5, 1.2, Some(0.1), 0.5),
            "anomaly alone fires"
        );
        assert!(
            !neural_fired(0.5, 1.2, Some(0.1), 0.5),
            "neither signal fires"
        );
    }

    #[test]
    fn risk_bounded_and_monotonic() {
        assert_eq!(fused_risk(1.2, 1.2, None), 0.0, "at threshold => 0");
        assert!(
            (fused_risk(1.8, 1.2, None) - 0.5).abs() < 1e-6,
            "1.5x threshold => 0.5"
        );
        assert!(
            (fused_risk(2.4, 1.2, None) - 1.0).abs() < 1e-6,
            "2x threshold => 1"
        );
        assert!(
            (fused_risk(1.2, 1.2, Some(0.8)) - 0.8).abs() < 1e-6,
            "classifier dominates when anomaly is 0"
        );
        assert!(
            (fused_risk(2.4, 1.2, Some(0.3)) - 1.0).abs() < 1e-6,
            "max of both signals wins"
        );
        assert!(
            fused_risk(1.0, 1.2, Some(0.9)) > fused_risk(1.0, 1.2, Some(0.2)),
            "monotonic in prob"
        );
        assert_eq!(
            fused_risk(0.5, 0.0, None),
            0.5,
            "zero threshold: anomaly score = risk"
        );
        assert_eq!(
            fused_risk(0.5, 0.0, Some(0.7)),
            0.7,
            "zero threshold: prob only"
        );
    }
}

#[cfg(test)]
mod content_ref_tests {
    use super::*;
    use crate::private_file::create_private_file;

    #[test]
    fn reference_hides_the_text_and_is_stable() {
        let r = content_ref("secret call text");
        assert_eq!(r.len(), 18);
        assert!(r.starts_with("h:"));
        assert!(!r.contains("secret"));
        assert_eq!(r, content_ref("secret call text"));
        assert_ne!(r, content_ref("other text"));
        assert_eq!(content_ref(&r), r);
    }

    #[test]
    fn hmac_matches_rfc_4231_case_2() {
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            hex::encode(mac),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn hmac_matches_rfc_4231_case_6_key_longer_than_the_block() {
        let key = [0xaau8; 131];
        let mac = hmac_sha256(
            &key,
            b"Test Using Larger Than Block-Size Key - Hash Key First",
        );
        assert_eq!(
            hex::encode(mac),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn hmac_matches_rfc_4231_case_7_key_and_data_longer_than_the_block() {
        let key = [0xaau8; 131];
        let mac = hmac_sha256(
            &key,
            b"This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.",
        );
        assert_eq!(
            hex::encode(mac),
            "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2"
        );
    }

    #[test]
    fn reference_is_keyed_and_stable_across_openings() {
        use sha2::{Digest, Sha256};
        let dir = tempfile::tempdir().unwrap();
        let k1 = load_or_create_ref_key(dir.path()).unwrap();
        let k2 = load_or_create_ref_key(dir.path()).unwrap();
        assert_eq!(k1, k2, "the same key file must give the same key");
        let text = "login: {\"pin\":\"4821\"}";
        let r1 = content_ref_with_key(&k1, text);
        assert_eq!(r1, content_ref_with_key(&k2, text));
        let unkeyed = format!("h:{}", hex::encode(&Sha256::digest(text.as_bytes())[..8]));
        assert_ne!(r1, unkeyed, "the reference must not be a plain SHA-256");
        let other = dir.path().join("other");
        let k3 = load_or_create_ref_key(&other).unwrap();
        assert_ne!(k1, k3);
        assert_ne!(r1, content_ref_with_key(&k3, text));
    }

    #[cfg(unix)]
    #[test]
    fn key_file_is_private_and_a_short_key_is_replaced() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        load_or_create_ref_key(dir.path()).unwrap();
        let meta = std::fs::metadata(dir.path().join("ref.key")).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        assert_eq!(meta.len(), 32);
        std::fs::remove_file(dir.path().join("ref.key")).unwrap();
        create_private_file(&dir.path().join("ref.key"), b"short").unwrap();
        let key = load_or_create_ref_key(dir.path()).unwrap();
        assert_eq!(std::fs::read(dir.path().join("ref.key")).unwrap(), key);
    }

    #[test]
    fn a_truncated_key_is_replaced_never_used() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ref.key");
        for bad in [0usize, 17, 33] {
            create_private_file(&path, &vec![7u8; bad]).unwrap();
            let (key, regenerated) = load_ref_key(dir.path()).unwrap();
            assert!(regenerated, "a key of {bad} bytes must be replaced");
            assert_eq!(std::fs::read(&path).unwrap().len(), 32);
            assert_eq!(std::fs::read(&path).unwrap(), key.to_vec());
            let (again, regenerated) = load_ref_key(dir.path()).unwrap();
            assert!(!regenerated);
            assert_eq!(again, key);
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_key_with_wrong_protection_is_refused_not_regenerated() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ref.key");
        create_private_file(&path, &[1u8; 17]).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load_ref_key(dir.path()).is_err());
        assert_eq!(
            std::fs::read(&path).unwrap(),
            vec![1u8; 17],
            "left untouched"
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_existing_key_that_is_a_link_or_open_to_others_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = dir.path().join("known-32-bytes");
        std::fs::write(&elsewhere, [9u8; 32]).unwrap();
        std::fs::set_permissions(&elsewhere, std::fs::Permissions::from_mode(0o600)).unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir(&data).unwrap();
        std::os::unix::fs::symlink(&elsewhere, data.join("ref.key")).unwrap();
        assert!(
            load_or_create_ref_key(&data).is_err(),
            "a ref.key that is a link must be refused"
        );
        std::fs::remove_file(data.join("ref.key")).unwrap();

        std::fs::write(data.join("ref.key"), [9u8; 32]).unwrap();
        std::fs::set_permissions(data.join("ref.key"), std::fs::Permissions::from_mode(0o644))
            .unwrap();
        assert!(
            load_or_create_ref_key(&data).is_err(),
            "a ref.key that others can read must be refused"
        );
        std::fs::set_permissions(data.join("ref.key"), std::fs::Permissions::from_mode(0o600))
            .unwrap();
        assert_eq!(load_or_create_ref_key(&data).unwrap(), [9u8; 32]);
    }

    #[cfg(unix)]
    #[test]
    fn a_key_folder_that_group_or_others_can_write_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir(&data).unwrap();
        for mode in [0o775, 0o757] {
            std::fs::set_permissions(&data, std::fs::Permissions::from_mode(mode)).unwrap();
            assert!(
                load_or_create_ref_key(&data).is_err(),
                "folder mode {mode:o} must be refused"
            );
            assert!(!data.join("ref.key").exists(), "no key is created there");
        }
        std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700)).unwrap();
        load_or_create_ref_key(&data).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_key_folder_that_is_a_link_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(load_or_create_ref_key(&link).is_err());
        assert!(!real.join("ref.key").exists());
    }

    #[test]
    fn processes_that_find_a_truncated_key_together_end_with_the_same_key() {
        for round in 0..40 {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("ref.key");
            create_private_file(&path, b"short").unwrap();
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
            let handles: Vec<_> = (0..8)
                .map(|_| {
                    let (b, d) = (barrier.clone(), dir.path().to_path_buf());
                    std::thread::spawn(move || {
                        b.wait();
                        load_or_create_ref_key(&d).unwrap()
                    })
                })
                .collect();
            let keys: Vec<[u8; 32]> = handles.into_iter().map(|h| h.join().unwrap()).collect();
            let on_disk = std::fs::read(&path).unwrap();
            for k in &keys {
                assert_eq!(
                    k.to_vec(),
                    on_disk,
                    "round {round}: a key was not the one on disk"
                );
            }
            assert!(!dir.path().join("ref.key.lock").exists(), "lock removed");
        }
    }

    #[test]
    fn a_stale_lock_does_not_block_the_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ref.key");
        create_private_file(&path, b"short").unwrap();
        let lock = dir.path().join("ref.key.lock");
        std::fs::write(&lock, b"99999").unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(120);
        std::fs::File::options()
            .write(true)
            .open(&lock)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let key = load_or_create_ref_key(dir.path()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), key.to_vec());
        assert!(!lock.exists());
    }
}
