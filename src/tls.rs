//! Process-wide TLS provider.
//!
//! The dependency tree has one rustls crypto backend, aws-lc-rs: reqwest, the AWS SDK, the
//! OpenTelemetry exporter, the websocket client and jsonwebtoken all use it. Installing it
//! explicitly at startup keeps the choice from depending on feature unification: if a crate
//! ever enables a second backend, rustls 0.23 would panic the first time a default-provider
//! config is built, because it cannot pick one.

/// Installs aws-lc-rs as the process default. Safe to call more than once: if a provider is
/// already installed, it is left in place.
pub fn install_default_crypto_provider() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A reqwest client built without TLS support refuses an `https` URL before it connects
    /// (a builder error). With rustls it gets as far as the connection, which is refused.
    /// This pins that every client of the gateway keeps TLS after a dependency change.
    #[tokio::test]
    async fn reqwest_clients_support_https() {
        install_default_crypto_provider();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let err = client
            .get("https://127.0.0.1:1/")
            .send()
            .await
            .expect_err("nothing listens on port 1");
        assert!(!err.is_builder(), "https is not supported: {err}");
        assert!(err.is_connect(), "expected a connection error: {err}");
        // Without TLS the connector fails on the scheme instead of on the refused connection.
        assert!(
            !format!("{err:?}").contains("scheme"),
            "https is not supported: {err:?}"
        );
    }

    #[test]
    fn installing_twice_keeps_one_default() {
        install_default_crypto_provider();
        install_default_crypto_provider();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }
}
