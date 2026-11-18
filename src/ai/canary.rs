//! Canary deployment for model backends: hot-swap via `Mutex<Arc<dyn>>`
//! (sub-µs lock; negligible vs the ~4 ms embed), per-agent rollout
//! percentage (stable hash), FPR guard with auto-rollback, and an evals
//! gate before promotion.
//!
//! The decision loop feeds one `note` per call; the pure `should_rollback`
//! logic is unit-tested here. Live audit wiring lands in E-2.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};

/// Decision counters feeding the FPR guard.
/// FP = neural flagged but the rule layers allowed it; TN = not flagged & allowed.
#[derive(Debug, Default, Clone, Copy)]
pub struct CanaryStats {
    pub canary_total: u64,
    pub control_total: u64,
    pub canary_fp: u64,
    pub control_fp: u64,
    pub canary_tn: u64,
    pub control_tn: u64,
}

impl CanaryStats {
    /// `bucket` = served by the canary, `flagged` = neural fired, `allowed` = allowed at the end.
    pub fn note(&mut self, bucket: bool, flagged: bool, allowed: bool) {
        if bucket {
            self.canary_total += 1;
        } else {
            self.control_total += 1;
        }
        if allowed {
            if flagged {
                if bucket {
                    self.canary_fp += 1;
                } else {
                    self.control_fp += 1;
                }
            } else if bucket {
                self.canary_tn += 1;
            } else {
                self.control_tn += 1;
            }
        }
    }

    pub fn canary_fpr(&self) -> f64 {
        fpr_of(self.canary_fp, self.canary_tn)
    }

    pub fn control_fpr(&self) -> f64 {
        fpr_of(self.control_fp, self.control_tn)
    }

    /// Rollback rule: enough canary samples AND canary FPR above control FPR + margin.
    pub fn should_rollback(&self, min_samples: u64, margin: f64) -> bool {
        if self.canary_total < min_samples {
            return false;
        }
        self.canary_fpr() > self.control_fpr() + margin
    }
}

fn fpr_of(fp: u64, tn: u64) -> f64 {
    let d = fp + tn;
    if d == 0 {
        return 0.0;
    }
    fp as f64 / d as f64
}

struct Canary {
    model: Arc<dyn super::ModelBackend>,
    pct: u8,
}

/// Hot-swappable model deployer. `current` is the always-healthy backend;
/// `canary` (when set) serves a stable % of agents.
pub struct CanaryDeployer {
    current: Mutex<Arc<dyn super::ModelBackend>>,
    canary: Mutex<Option<Canary>>,
    stats: Mutex<CanaryStats>,
}

impl CanaryDeployer {
    pub fn new(current: Arc<dyn super::ModelBackend>) -> Self {
        Self {
            current: Mutex::new(current),
            canary: Mutex::new(None),
            stats: Mutex::new(CanaryStats::default()),
        }
    }

    /// Record one decision for the agent's routed bucket.
    pub fn note(&self, agent_id: &str, flagged: bool, allowed: bool) {
        let bucket = self.is_canary_bucket(agent_id);
        self.stats.lock().unwrap().note(bucket, flagged, allowed);
    }

    pub fn stats(&self) -> CanaryStats {
        *self.stats.lock().unwrap()
    }

    /// FPR of the serving population: the canary while one is active (the
    /// population the FPR guard watches), otherwise the control bucket.
    pub fn serving_fpr(&self) -> f64 {
        let s = self.stats();
        if self.has_canary() {
            s.canary_fpr()
        } else {
            s.control_fpr()
        }
    }

    /// Roll back with the live stats. True if it rolled.
    pub fn enforce_guard(&self, min_samples: u64, margin: f64) -> bool {
        let s = self.stats();
        self.enforce_fpr_guard(&s, min_samples, margin)
    }

    /// Stable bucket in [0, 100). Same agent always lands in the same bucket.
    pub fn bucket(agent_id: &str) -> u8 {
        let mut h = DefaultHasher::new();
        agent_id.hash(&mut h);
        (h.finish() % 100) as u8
    }

    pub fn active(&self) -> Arc<dyn super::ModelBackend> {
        self.current.lock().unwrap().clone()
    }

    pub fn has_canary(&self) -> bool {
        self.canary.lock().unwrap().is_some()
    }

    /// Route one agent to the backend serving it (canary when in-bucket).
    pub fn backend_for(&self, agent_id: &str) -> Arc<dyn super::ModelBackend> {
        let c = {
            let g = self.canary.lock().unwrap();
            g.as_ref().and_then(|c| {
                if Self::bucket(agent_id) < c.pct {
                    Some(Arc::clone(&c.model))
                } else {
                    None
                }
            })
        };
        match c {
            Some(m) => m,
            None => self.current.lock().unwrap().clone(),
        }
    }

    /// True if `agent_id` is currently served by the canary (stats bucketing).
    pub fn is_canary_bucket(&self, agent_id: &str) -> bool {
        self.canary
            .lock()
            .unwrap()
            .as_ref()
            .map(|c| Self::bucket(agent_id) < c.pct)
            .unwrap_or(false)
    }

    /// Start (or replace) the canary with `pct` in 1..=100.
    pub fn set_canary(&self, model: Arc<dyn super::ModelBackend>, pct: u8) {
        let pct = pct.clamp(1, 100);
        *self.canary.lock().unwrap() = Some(Canary { model, pct });
    }

    /// Promote the canary to current (hot swap). Requires a passed evals gate.
    /// Returns false (canary untouched) if the gate did not pass.
    pub fn promote(&self, gate_passed: bool) -> bool {
        if !gate_passed {
            return false;
        }
        let canary = self.canary.lock().unwrap().take();
        match canary {
            Some(c) => {
                *self.current.lock().unwrap() = Arc::clone(&c.model);
                true
            }
            None => false,
        }
    }

    /// Drop the canary; `current` keeps serving everyone.
    pub fn rollback(&self) {
        *self.canary.lock().unwrap() = None;
    }

    /// Roll back automatically when the FPR guard trips. True if it rolled.
    pub fn enforce_fpr_guard(&self, stats: &CanaryStats, min_samples: u64, margin: f64) -> bool {
        if stats.should_rollback(min_samples, margin) {
            self.rollback();
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::ModelBackend;

    struct Stub {
        name: String,
    }
    impl ModelBackend for Stub {
        fn embed(&self, _t: &str) -> anyhow::Result<Vec<f32>> {
            Ok(vec![1.0])
        }
        fn classify(&self, _v: &[f32]) -> anyhow::Result<Option<f32>> {
            Ok(None)
        }
        fn name(&self) -> &str {
            &self.name
        }
        fn dim(&self) -> usize {
            1
        }
    }

    #[test]
    fn bucket_is_stable_and_in_range() {
        for agent in ["agent-1", "tenant:42:op", "x"] {
            let b1 = CanaryDeployer::bucket(agent);
            let b2 = CanaryDeployer::bucket(agent);
            assert_eq!(b1, b2, "bucket must be deterministic");
            assert!(b1 < 100);
        }
    }

    #[test]
    fn routing_respects_canary_pct() {
        let cur: Arc<dyn ModelBackend> = Arc::new(Stub { name: "cur".into() });
        let can: Arc<dyn ModelBackend> = Arc::new(Stub { name: "can".into() });
        let d = CanaryDeployer::new(Arc::clone(&cur));
        assert!(!d.has_canary());
        assert_eq!(d.backend_for("agent-1").name(), "cur");

        d.set_canary(Arc::clone(&can), 100);
        assert_eq!(d.backend_for("agent-1").name(), "can", "100% => everyone");

        d.rollback();
        assert!(!d.has_canary());
        assert_eq!(d.backend_for("agent-1").name(), "cur");

        d.set_canary(Arc::clone(&can), 1);
        // at 1%, routing must agree with the bucket function for every agent
        for i in 0..200u32 {
            let a = format!("agent-{i}");
            let expected = if CanaryDeployer::bucket(&a) < 1 {
                "can"
            } else {
                "cur"
            };
            assert_eq!(d.backend_for(&a).name(), expected);
        }
    }

    #[test]
    fn promote_requires_gate_and_hot_swaps() {
        let cur: Arc<dyn ModelBackend> = Arc::new(Stub { name: "cur".into() });
        let can: Arc<dyn ModelBackend> = Arc::new(Stub { name: "can".into() });
        let d = CanaryDeployer::new(cur);
        d.set_canary(Arc::clone(&can), 50);
        assert!(!d.promote(false), "no promotion without gate");
        assert!(d.has_canary());
        assert!(d.promote(true));
        assert!(!d.has_canary());
        assert_eq!(
            d.active().name(),
            "can",
            "hot-swap must install canary as current"
        );
    }

    #[test]
    fn fpr_guard_trips_rollback_only_when_worse() {
        let mut good = CanaryStats::default();
        for _ in 0..60 {
            good.note(true, false, true); // canary TNs
        }
        good.note(true, true, true); // 1 canary FP
        for _ in 0..60 {
            good.note(false, false, true); // control TNs
        }
        good.note(false, true, true); // 1 control FP (parity)
        assert!(!good.should_rollback(50, 0.02), "parity must not trip");
        assert!((good.canary_fpr() - 1.0 / 61.0).abs() < 1e-9);

        let mut bad = good;
        for _ in 0..15 {
            bad.note(true, true, true); // 15 more canary FPs
        }
        assert!(
            bad.should_rollback(50, 0.02),
            "canary FPR well above control must trip"
        );

        let mut starved = CanaryStats::default();
        starved.note(true, true, true);
        starved.note(true, true, true);
        assert!(
            !starved.should_rollback(50, 0.0),
            "no rollback without min samples"
        );
    }

    #[test]
    fn enforce_rolls_back_on_trip() {
        let cur: Arc<dyn ModelBackend> = Arc::new(Stub { name: "cur".into() });
        let can: Arc<dyn ModelBackend> = Arc::new(Stub { name: "can".into() });
        let d = CanaryDeployer::new(cur);
        d.set_canary(can, 10);
        let mut s = CanaryStats::default();
        for _ in 0..60 {
            s.note(true, false, true);
        }
        for _ in 0..60 {
            s.note(false, false, true);
        }
        for _ in 0..20 {
            s.note(true, true, true); // canary FPs
        }
        for _ in 0..5 {
            s.note(false, true, true); // fewer control FPs
        }
        assert!(d.enforce_fpr_guard(&s, 50, 0.02));
        assert!(!d.has_canary(), "rollback must drop the canary");
    }

    fn stub(name: &str) -> Arc<dyn ModelBackend> {
        Arc::new(Stub { name: name.into() })
    }

    /// Canary: `fp` flagged-and-allowed, `tn` clean; control the same.
    fn stats(c_fp: u64, c_tn: u64, k_fp: u64, k_tn: u64) -> CanaryStats {
        let mut s = CanaryStats::default();
        for _ in 0..c_fp {
            s.note(true, true, true);
        }
        for _ in 0..c_tn {
            s.note(true, false, true);
        }
        for _ in 0..k_fp {
            s.note(false, true, true);
        }
        for _ in 0..k_tn {
            s.note(false, false, true);
        }
        s
    }

    #[test]
    fn rollback_at_exactly_min_samples_is_allowed_to_trip() {
        // 10 canary samples with FPR 0.5 against a clean control.
        let s = stats(5, 5, 0, 10);
        assert_eq!(s.canary_total, 10);
        assert!(s.should_rollback(10, 0.0), "exactly min_samples counts");
        assert!(
            !s.should_rollback(11, 0.0),
            "one sample short must not trip"
        );
        assert!(s.should_rollback(9, 0.0));
    }

    #[test]
    fn rollback_margin_equal_to_the_gap_does_not_trip() {
        // canary FPR 0.5, control FPR 0.25: the gap is exactly 0.25
        // (all values are exact binary fractions).
        let s = stats(2, 2, 1, 3);
        assert_eq!(s.canary_fpr(), 0.5);
        assert_eq!(s.control_fpr(), 0.25);
        assert!(!s.should_rollback(1, 0.25), "gap == margin is not above it");
        assert!(s.should_rollback(1, 0.125), "margin below the gap trips");
        assert!(!s.should_rollback(1, 0.5), "margin above the gap does not");
    }

    #[test]
    fn rollback_with_zero_samples_never_trips() {
        let s = CanaryStats::default();
        assert_eq!(s.canary_fpr(), 0.0);
        assert_eq!(s.control_fpr(), 0.0);
        assert!(!s.should_rollback(0, 0.0));
        assert!(!s.should_rollback(1, 0.0));
        assert!(!s.should_rollback(u64::MAX, 0.0));
    }

    #[test]
    fn rollback_when_every_canary_decision_is_a_false_positive() {
        let s = stats(100, 0, 0, 100);
        assert_eq!(s.canary_fpr(), 1.0);
        assert_eq!(s.control_fpr(), 0.0);
        assert!(s.should_rollback(50, 0.5));
        // Margin of 1.0 can never be exceeded by an FPR that is at most 1.0.
        assert!(!s.should_rollback(50, 1.0));
    }

    #[test]
    fn rollback_never_trips_when_every_decision_is_allowed_and_clean() {
        let s = stats(0, 500, 0, 500);
        assert_eq!(s.canary_fpr(), 0.0);
        assert!(!s.should_rollback(1, 0.0));
    }

    #[test]
    fn rollback_ignores_blocked_decisions_in_the_fpr_but_not_in_the_sample_count() {
        let mut s = CanaryStats::default();
        // flagged and blocked: counted in the total, in neither FP nor TN
        for _ in 0..10 {
            s.note(true, true, false);
        }
        assert_eq!(s.canary_total, 10);
        assert_eq!(s.canary_fp + s.canary_tn, 0);
        assert_eq!(s.canary_fpr(), 0.0);
        assert!(!s.should_rollback(10, 0.0));
    }

    #[test]
    fn rollback_does_not_trip_when_control_is_worse_than_canary() {
        let s = stats(0, 100, 30, 70);
        assert!(s.control_fpr() > s.canary_fpr());
        assert!(!s.should_rollback(50, 0.0));
    }

    #[test]
    fn enforce_guard_uses_the_live_stats_and_drops_the_canary() {
        let d = CanaryDeployer::new(stub("cur"));
        d.set_canary(stub("can"), 100); // everyone is in the canary bucket
        for i in 0..40 {
            d.note(&format!("agent-{i}"), false, true);
        }
        for i in 0..10 {
            d.note(&format!("agent-{i}"), true, true); // 10 FPs in 50 samples
        }
        assert_eq!(d.stats().canary_total, 50);
        assert!(d.has_canary());
        // One sample above the live total: the guard must hold.
        assert!(!d.enforce_guard(51, 0.0));
        assert!(d.has_canary());
        // Exactly at the live total, margin above the FPR (0.2): holds.
        assert!(!d.enforce_guard(50, 0.2));
        assert!(d.has_canary());
        // Exactly at the live total, margin below the FPR: rolls back.
        assert!(d.enforce_guard(50, 0.1));
        assert!(!d.has_canary());
        assert_eq!(d.backend_for("agent-1").name(), "cur");
        // Without a canary the same call still reports the stats rule, and
        // rolling back again is harmless.
        assert!(d.enforce_guard(50, 0.1));
        assert!(!d.has_canary());
    }

    #[test]
    fn enforce_guard_with_no_samples_does_nothing() {
        let d = CanaryDeployer::new(stub("cur"));
        d.set_canary(stub("can"), 10);
        assert!(!d.enforce_guard(0, 0.0));
        assert!(!d.enforce_guard(100, 0.0));
        assert!(d.has_canary());
    }

    #[test]
    fn enforce_fpr_guard_with_a_clean_canary_keeps_it() {
        let d = CanaryDeployer::new(stub("cur"));
        d.set_canary(stub("can"), 10);
        let s = stats(0, 200, 5, 195);
        assert!(!d.enforce_fpr_guard(&s, 50, 0.0));
        assert!(d.has_canary());
    }

    #[test]
    fn serving_fpr_follows_the_canary_while_one_is_active() {
        let d = CanaryDeployer::new(stub("cur"));
        // 100%: every note lands in the canary bucket.
        d.set_canary(stub("can"), 100);
        d.note("a", true, true);
        d.note("b", false, true);
        assert_eq!(d.serving_fpr(), 0.5);
        d.rollback();
        // No canary: notes land in control, and nothing was noted there yet.
        assert_eq!(d.serving_fpr(), 0.0);
        d.note("a", true, true);
        assert_eq!(d.serving_fpr(), 1.0);
    }

    #[test]
    fn set_canary_clamps_the_percentage() {
        let d = CanaryDeployer::new(stub("cur"));
        // 0 is clamped up to 1: still a canary, and at most ~1% of agents.
        d.set_canary(stub("can"), 0);
        assert!(d.has_canary());
        let routed = (0..1000)
            .filter(|i| d.is_canary_bucket(&format!("agent-{i}")))
            .count();
        assert!(routed < 50, "1% canary routed {routed} of 1000 agents");
        // Above 100 is clamped down: everyone is served by the canary.
        d.set_canary(stub("can"), 250);
        assert!((0..1000).all(|i| d.is_canary_bucket(&format!("agent-{i}"))));
    }

    #[test]
    fn promote_without_a_canary_returns_false_and_keeps_current() {
        let d = CanaryDeployer::new(stub("cur"));
        assert!(!d.promote(true));
        assert_eq!(d.active().name(), "cur");
    }

    #[test]
    fn bucket_is_stable_across_instances_and_calls() {
        let ids: Vec<String> = (0..500).map(|i| format!("fake-agent-{i}")).collect();
        let first: Vec<u8> = ids.iter().map(|a| CanaryDeployer::bucket(a)).collect();
        for _ in 0..3 {
            let again: Vec<u8> = ids.iter().map(|a| CanaryDeployer::bucket(a)).collect();
            assert_eq!(first, again);
        }
        // Not tied to a deployer instance.
        let d = CanaryDeployer::new(stub("cur"));
        d.set_canary(stub("can"), 100);
        assert!(ids.iter().all(|a| d.is_canary_bucket(a)));
    }

    #[test]
    fn bucket_is_roughly_even_over_ten_thousand_agent_ids() {
        const N: usize = 10_000;
        let mut counts = [0usize; 100];
        for i in 0..N {
            let b = CanaryDeployer::bucket(&format!("tenant-{}:agent-{i}", i % 7)) as usize;
            assert!(b < 100);
            counts[b] += 1;
        }
        assert_eq!(counts.iter().sum::<usize>(), N);
        // Expected 100 per bucket (sd 10): a wide band of +-60 keeps this stable.
        for (b, c) in counts.iter().enumerate() {
            assert!((40..=160).contains(c), "bucket {b} got {c} of {N}");
        }
        // Every bucket is used.
        assert!(counts.iter().all(|&c| c > 0));
        // The share below a threshold tracks the percentage (a 10% canary serves ~10%).
        let below_10: usize = counts[..10].iter().sum();
        assert!(
            (700..=1300).contains(&below_10),
            "10% canary served {below_10} of {N}"
        );
    }

    #[test]
    fn empty_and_unicode_agent_ids_have_a_valid_stable_bucket() {
        let long = "a".repeat(10_000);
        for id in [
            "",
            " ",
            "agent-\u{00e9}",
            "\u{4e2d}\u{6587}-agent",
            long.as_str(),
        ] {
            let b = CanaryDeployer::bucket(id);
            assert!(b < 100);
            assert_eq!(b, CanaryDeployer::bucket(id));
        }
    }
}
