### Security
- Private keys in the OpenPGP format (`-----BEGIN PGP PRIVATE KEY BLOCK-----`) are now redacted like other private keys: in the preview of the evidence log, in redacted text and in `zn-gate scan` output. Before, the key could show in the first 120 characters of the evidence log preview.
