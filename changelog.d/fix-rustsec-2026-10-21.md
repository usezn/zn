### Security
- The experimental gateway uses rustls-webpki 0.103.16 and webpki-root-certs 1.0.10, which no longer trust distrusted emSign intermediates (RUSTSEC-2026-0382, RUSTSEC-2026-0383), and wasmtime 48.0.7 (RUSTSEC-2026-0378, RUSTSEC-2026-0379).
