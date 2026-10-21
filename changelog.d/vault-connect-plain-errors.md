### Changed
- Keychain, vault and audit-log errors now say what happened and one next step in plain words, for macOS, Windows and Linux (for example "allow zn in the Keychain window", "install the libsecret-tools package", "run `zn lock`, then `zn unlock`"). The technical code is shown only with `ZN_VERBOSE=1`.
- `zn-gate connect` and `zn-gate disconnect` explain network problems in plain words ("Could not reach usezn.com ... check your internet connection") instead of error codes, and when your terminal has a setting that stops the key from being sent (such as `NODE_OPTIONS`) they name it and show how to remove it in your shell.
- `zn-gate connect` prints its "no keychain and the vault is locked" explanation on the error output with a single next step (`unlock`, then `connect` again) instead of setting names.
- `zn unlock` and `zn vault status` show the time the session ends in your local time with the hours left ("until 23:09 (in 8 h)"), and `zn unlock --foreground` says why the vault locked ("it was not used for 30 min") instead of an internal word.

### Fixed
- The commands that zn suggests (`unlock`, `lock`, `vault reset`, `env shadow` and others) are now the `npx -y zn-gate@<version>` form when `zn` is not installed on your computer, so you are never told to type a command that does not exist.
- `zn unlock`, `zn lock` and `zn vault status|verify|forget|reset` now stop with a usage message and exit code 2 on an option they do not know, an option without its value or an extra word, instead of ignoring it. An invalid `--ttl` or `--idle` and an unknown `--backend` also exit 2, as the documentation says.
