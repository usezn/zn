### Security
- Files in `~/.gnupg` (private keys, keyrings and trust database) are now protected like `~/.ssh/id_*` and `~/.aws/credentials`: reading them with `cat` or any other tool is refused. The `gpg` program using its own keyring (`gpg --list-keys`) is not affected.
