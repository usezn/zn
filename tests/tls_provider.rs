//! Building a default TLS client config must not panic when two crypto backends are enabled.

#[test]
fn default_client_config_builds_after_provider_install() {
    zn::tls::install_default_crypto_provider();
    // Calling it again must be harmless.
    zn::tls::install_default_crypto_provider();
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(rustls::RootCertStore::empty())
        .with_no_client_auth();
    drop(config);
    reqwest::Client::builder().build().expect("reqwest client");
}
