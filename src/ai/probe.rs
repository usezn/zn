//! Neural-layer probe shared by `zn serve`, `zn analyze` and `zn mcp`.
//!
//! The probe runs embed, classify and the nearest-neighbour search and keeps
//! every error instead of dropping it, so the caller can log it, count it and
//! deny the call when neural blocking is on. Before this, a failing stage was
//! skipped silently and the call ended allowed.

use std::sync::Arc;
use std::time::{Duration, Instant};

use super::{ModelBackend, VectorMemory};

/// One failed neural stage.
#[derive(Debug)]
pub struct NeuralError {
    /// `embed`, `classify` or `search`.
    pub stage: &'static str,
    pub error: anyhow::Error,
}

/// What the neural layer produced for one input, with the errors it hit.
#[derive(Debug, Default)]
pub struct NeuralProbe {
    /// The embedding, or `None` when `embed` failed (nothing else ran then).
    pub vec: Option<Vec<f32>>,
    /// Classifier probability, `None` in anomaly-only mode or when it failed.
    pub prob: Option<f32>,
    /// Nearest stored text and its distance, if the search found one.
    pub nearest: Option<(String, f32)>,
    /// Time spent in embed plus classify.
    pub embed_elapsed: Duration,
    pub errors: Vec<NeuralError>,
}

impl NeuralProbe {
    pub fn failed(&self) -> bool {
        !self.errors.is_empty()
    }

    /// Log every error at error level and count it. Returns true when the
    /// call must be denied: a stage failed and `blocking` is on.
    pub fn report_errors(&self, context: &str, blocking: bool) -> bool {
        for e in &self.errors {
            tracing::error!(
                "Neural {} failed for {}: {:#} ({})",
                e.stage,
                context,
                e.error,
                if blocking {
                    "denying the call"
                } else {
                    "shadow mode, the call continues"
                }
            );
            crate::metrics::record_neural_error(e.stage);
        }
        blocking && self.failed()
    }
}

/// Run embed, classify and search. A failed `embed` stops the probe; a failed
/// `classify` or `search` is recorded and the other signal is still used.
pub async fn probe(
    model: &dyn ModelBackend,
    memory: &VectorMemory,
    namespace: &str,
    agent_id: &str,
    input: &str,
) -> NeuralProbe {
    let mut out = NeuralProbe::default();
    let start = Instant::now();
    let vec = match model.embed(input) {
        Ok(v) => v,
        Err(error) => {
            out.embed_elapsed = start.elapsed();
            out.errors.push(NeuralError {
                stage: "embed",
                error,
            });
            return out;
        }
    };
    match model.classify(&vec) {
        Ok(p) => out.prob = p,
        Err(error) => out.errors.push(NeuralError {
            stage: "classify",
            error,
        }),
    }
    out.embed_elapsed = start.elapsed();
    match memory.search(namespace, agent_id, &vec, 1).await {
        Ok(r) => out.nearest = r.into_iter().next(),
        Err(error) => out.errors.push(NeuralError {
            stage: "search",
            error,
        }),
    }
    out.vec = Some(vec);
    out
}

/// Choose the backend for the CLI pipeline. The stub is used only when
/// `fast_boot` (ZN_FAST_BOOT) is set or neural is disabled in the config. A
/// model that fails to load is an error, never a silent switch to the stub
/// that cannot fire.
pub fn pipeline_backend<F>(
    fast_boot: bool,
    neural_enabled: bool,
    dim: usize,
    load: F,
) -> anyhow::Result<Arc<dyn ModelBackend>>
where
    F: FnOnce() -> anyhow::Result<Arc<dyn ModelBackend>>,
{
    if fast_boot || !neural_enabled {
        let dim = if dim > 0 { dim } else { 384 };
        return Ok(Arc::new(super::FastBootBackend::new(dim)));
    }
    load().map_err(|e| {
        anyhow::anyhow!(
            "the neural model failed to load: {e:#}. Fix the model path (ZN_NEURAL_MODEL_PATH or neural.model_path) \
             or set ZN_FAST_BOOT=1 to run without the neural layer on purpose"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::{anyhow, Result};

    struct Fake {
        embed_err: bool,
        classify_err: bool,
    }
    impl ModelBackend for Fake {
        fn embed(&self, _: &str) -> Result<Vec<f32>> {
            if self.embed_err {
                Err(anyhow!("embed boom"))
            } else {
                Ok(vec![0.0; 4])
            }
        }
        fn classify(&self, _: &[f32]) -> Result<Option<f32>> {
            if self.classify_err {
                Err(anyhow!("classify boom"))
            } else {
                Ok(None)
            }
        }
        fn name(&self) -> &str {
            "fake"
        }
        fn dim(&self) -> usize {
            4
        }
    }

    fn mem(dim: i32) -> VectorMemory {
        let dir = std::env::temp_dir().join(format!("zn-probe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        VectorMemory::new(dir.to_str().unwrap(), dim, "probe-test")
    }

    #[tokio::test]
    async fn embed_error_denies_when_blocking_and_allows_in_shadow() {
        let m = mem(4);
        let p = probe(
            &Fake {
                embed_err: true,
                classify_err: false,
            },
            &m,
            "ns",
            "a",
            "x",
        )
        .await;
        assert_eq!(p.errors.len(), 1);
        assert_eq!(p.errors[0].stage, "embed");
        assert!(p.vec.is_none());
        assert!(p.report_errors("t", true));
        assert!(!p.report_errors("t", false));
    }

    #[tokio::test]
    async fn classify_error_denies_when_blocking() {
        let m = mem(4);
        let p = probe(
            &Fake {
                embed_err: false,
                classify_err: true,
            },
            &m,
            "ns",
            "a",
            "x",
        )
        .await;
        assert_eq!(p.errors.len(), 1);
        assert_eq!(p.errors[0].stage, "classify");
        assert!(p.vec.is_some());
        assert!(p.report_errors("t", true));
        assert!(!p.report_errors("t", false));
    }

    #[tokio::test]
    async fn search_error_denies_when_blocking() {
        // Memory built for dim 8 rejects a 4-dim vector: search returns Err.
        let m = mem(8);
        let p = probe(
            &Fake {
                embed_err: false,
                classify_err: false,
            },
            &m,
            "ns",
            "a",
            "x",
        )
        .await;
        assert_eq!(p.errors.len(), 1);
        assert_eq!(p.errors[0].stage, "search");
        assert!(p.report_errors("t", true));
        assert!(!p.report_errors("t", false));
    }

    #[tokio::test]
    async fn healthy_probe_has_no_errors() {
        let m = mem(4);
        let p = probe(
            &Fake {
                embed_err: false,
                classify_err: false,
            },
            &m,
            "ns",
            "a",
            "x",
        )
        .await;
        assert!(!p.failed());
        assert!(!p.report_errors("t", true));
    }

    #[test]
    fn missing_model_without_fast_boot_is_an_error() {
        let r = pipeline_backend(false, true, 384, || Err(anyhow!("no such file")));
        let msg = format!("{:#}", r.err().expect("must fail"));
        assert!(msg.contains("ZN_FAST_BOOT"), "{msg}");
        assert!(msg.contains("no such file"), "{msg}");
    }

    #[test]
    fn fast_boot_uses_the_stub_without_loading() {
        let r = pipeline_backend(true, true, 0, || panic!("must not load")).unwrap();
        assert_eq!(r.dim(), 384);
    }

    #[test]
    fn neural_disabled_in_config_uses_the_stub() {
        let r = pipeline_backend(false, false, 16, || panic!("must not load")).unwrap();
        assert_eq!(r.dim(), 16);
    }
}
