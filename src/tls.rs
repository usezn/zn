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

/// Test-only HTTPS server on 127.0.0.1 with a throwaway self-signed certificate that no client
/// trusts. It records whether any TLS handshake completed and how many application bytes it
/// received, so tests can prove a client refused the certificate before sending its request.
#[cfg(test)]
pub(crate) mod untrusted_server {
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
    use std::io::Read;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    pub struct Probe {
        pub url: String,
        pub handshakes: Arc<AtomicUsize>,
        pub app_bytes: Arc<AtomicUsize>,
    }

    impl Probe {
        /// Fails unless the server saw no completed handshake and no request bytes.
        pub fn assert_nothing_received(&self) {
            // Give the server thread time to observe the client's alert and close.
            std::thread::sleep(std::time::Duration::from_millis(300));
            assert_eq!(
                self.handshakes.load(Ordering::SeqCst),
                0,
                "a handshake completed"
            );
            assert_eq!(
                self.app_bytes.load(Ordering::SeqCst),
                0,
                "the server received request bytes over an untrusted certificate"
            );
        }
    }

    /// Starts the server. The thread ends with the test process.
    pub fn spawn() -> Probe {
        super::install_default_crypto_provider();
        let key = rcgen::KeyPair::generate().unwrap();
        let mut params = rcgen::CertificateParams::new(vec!["localhost".to_string()]).unwrap();
        params
            .subject_alt_names
            .push(rcgen::SanType::IpAddress("127.0.0.1".parse().unwrap()));
        let cert = params.self_signed(&key).unwrap();
        let config = Arc::new(
            rustls::ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(
                    vec![CertificateDer::from(cert.der().to_vec())],
                    PrivateKeyDer::from(PrivatePkcs8KeyDer::from(key.serialize_der())),
                )
                .unwrap(),
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("https://{}/hook", listener.local_addr().unwrap());
        let handshakes = Arc::new(AtomicUsize::new(0));
        let app_bytes = Arc::new(AtomicUsize::new(0));
        let (h, b) = (handshakes.clone(), app_bytes.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut tcp) = stream else { continue };
                let Ok(mut conn) = rustls::ServerConnection::new(config.clone()) else {
                    continue;
                };
                let (h, b) = (h.clone(), b.clone());
                std::thread::spawn(move || {
                    tcp.set_read_timeout(Some(std::time::Duration::from_secs(5)))
                        .ok();
                    let mut counted = false;
                    loop {
                        if conn.complete_io(&mut tcp).is_err() {
                            return;
                        }
                        if !conn.is_handshaking() && !counted {
                            counted = true;
                            h.fetch_add(1, Ordering::SeqCst);
                        }
                        let mut buf = [0u8; 4096];
                        match conn.reader().read(&mut buf) {
                            Ok(0) => return,
                            Ok(n) => {
                                b.fetch_add(n, Ordering::SeqCst);
                            }
                            Err(_) => {}
                        }
                    }
                });
            }
        });
        Probe {
            url,
            handshakes,
            app_bytes,
        }
    }

    /// True when the error chain names a certificate verification failure.
    pub fn is_certificate_error(err: &dyn std::error::Error) -> bool {
        let mut text = format!("{err:?} {err}");
        let mut src = err.source();
        while let Some(e) = src {
            text.push_str(&format!(" {e:?} {e}"));
            src = e.source();
        }
        let t = text.to_lowercase();
        t.contains("certificate") || t.contains("unknownissuer") || t.contains("unknown issuer")
    }
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

    /// The default client (as used by the config sync and the plain `reqwest::Client::new()`
    /// paths) must refuse a certificate no trust store vouches for, and send nothing.
    #[tokio::test]
    async fn default_client_rejects_an_untrusted_certificate() {
        let probe = untrusted_server::spawn();
        let err = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .post(&probe.url)
            .body("secret-request-body")
            .send()
            .await
            .expect_err("a self-signed certificate must be rejected");
        assert!(untrusted_server::is_certificate_error(&err), "{err:?}");
        probe.assert_nothing_received();
    }

    #[test]
    fn installing_twice_keeps_one_default() {
        install_default_crypto_provider();
        install_default_crypto_provider();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }
}
