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

/// Content-free reference to a piece of text: `h:` plus the first 16 hex
/// characters of its SHA-256. The vector memory keeps this instead of the
/// text of a call (the vector alone gives the distance), and the audit log
/// and the logs name a nearest neighbour only by this reference. A value that
/// already is a reference is returned unchanged, so rows written by earlier
/// versions (which hold raw text) are turned into a reference on the way out.
pub fn content_ref(text: &str) -> String {
    use sha2::{Digest, Sha256};
    let is_ref = text.len() == 18
        && text.starts_with("h:")
        && text[2..].bytes().all(|b| b.is_ascii_hexdigit());
    if is_ref {
        return text.to_string();
    }
    let digest = Sha256::digest(text.as_bytes());
    format!("h:{}", hex::encode(&digest[..8]))
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
    use super::content_ref;

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
}
