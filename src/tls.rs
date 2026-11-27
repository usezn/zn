//! Process-wide TLS provider.
//!
//! The dependency tree enables two rustls crypto backends: aws-lc-rs (AWS SDK, OpenTelemetry
//! exporter, websocket client) and ring (reqwest 0.12). With more than one backend enabled and
//! no default installed, rustls 0.23 panics the first time a default-provider config is built.
//! Installing one explicitly at startup removes that dependence on feature unification.

/// Installs aws-lc-rs as the process default. Safe to call more than once: if a provider is
/// already installed, it is left in place.
pub fn install_default_crypto_provider() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}
