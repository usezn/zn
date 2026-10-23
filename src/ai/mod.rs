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
/// (random, mode 0600, written to a temporary file and linked into place so a
/// concurrent start cannot see a partial key) when it does not exist yet.
pub fn load_or_create_ref_key(dir: &std::path::Path) -> std::io::Result<[u8; 32]> {
    use std::io::{Error, ErrorKind, Write};
    let path = dir.join("ref.key");
    let read = |p: &std::path::Path| -> std::io::Result<[u8; 32]> {
        let bytes = std::fs::read(p)?;
        <[u8; 32]>::try_from(bytes.as_slice())
            .map_err(|_| Error::new(ErrorKind::InvalidData, "ref.key must hold exactly 32 bytes"))
    };
    match read(&path) {
        Ok(k) => return Ok(k),
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    std::fs::create_dir_all(dir)?;
    let mut key = [0u8; 32];
    {
        use rand::Rng;
        rand::rng().fill_bytes(&mut key);
    }
    let tmp = dir.join(format!("ref.key.tmp-{}", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(&key)?;
        f.sync_all()?;
    }
    let linked = std::fs::hard_link(&tmp, &path);
    let _ = std::fs::remove_file(&tmp);
    match linked {
        Ok(()) => Ok(key),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => read(&path),
        Err(e) => Err(e),
    }
}

/// Load (or create) the local reference key in `dir` and use it for every
/// `content_ref` of this process. Call it once at start, before anything is
/// written to the audit log or the vector memory.
pub fn init_ref_key(dir: &std::path::Path) -> std::io::Result<()> {
    let key = load_or_create_ref_key(dir)?;
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

/// True when `text` already has the shape of a reference (`h:` and 16 hex
/// characters).
pub fn is_content_ref(text: &str) -> bool {
    text.len() == 18 && text.starts_with("h:") && text[2..].bytes().all(|b| b.is_ascii_hexdigit())
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
    fn key_file_is_private_and_a_bad_key_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        load_or_create_ref_key(dir.path()).unwrap();
        let meta = std::fs::metadata(dir.path().join("ref.key")).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        assert_eq!(meta.len(), 32);
        std::fs::write(dir.path().join("ref.key"), b"short").unwrap();
        assert!(load_or_create_ref_key(dir.path()).is_err());
    }
}
