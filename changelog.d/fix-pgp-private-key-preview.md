### Security
- Private keys in the OpenPGP format (`-----BEGIN PGP PRIVATE KEY BLOCK-----`) are now treated like other private keys: they are redacted in the evidence log preview and in redacted text, and `zn-gate scan` reports them. Before, in the Node.js package, the start of such a key could show in the first 120 characters of the evidence log preview.
