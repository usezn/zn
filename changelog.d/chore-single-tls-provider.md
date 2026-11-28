### Changed
- The experimental gateway uses reqwest 0.13, the same version as its OpenTelemetry exporter, so the build has one HTTP client and one TLS crypto backend (aws-lc-rs) instead of two of each. The release binary is about 0.8 MB smaller. HTTPS keeps working in every client; a test pins it.
