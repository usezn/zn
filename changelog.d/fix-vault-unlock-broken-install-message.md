### Fixed
- `zn unlock` on an incomplete install (the bundled encryption library missing or failing to load) no longer says the vault looks damaged or suggests `zn vault reset`. It says the installation is incomplete and to reinstall zn-gate; the vault is untouched and opens again once the install is fixed.
