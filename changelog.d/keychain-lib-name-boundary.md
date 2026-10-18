### Fixed
- The rule that protects zn's key no longer mistakes a module named `cloud-keys` or `acme-cloud-key-manager` for zn's own `cloud-key` module.

### Security
- The key-protection rule now also recognises the module names when they are written with escape sequences (JavaScript or shell, such as `\x2f`) or split by quotes.
