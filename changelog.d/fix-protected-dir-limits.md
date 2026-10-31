### Security
- The pre-tool check now asks before `tar`, `zip`, `7z`, `cp`, `rsync` or `scp` packs, copies or sends a folder that is too large to look through (more than 3,000 entries, 6 levels or one second), instead of allowing it. Each folder in a command is looked at on its own, so a large folder no longer hides a protected one named after it.
- `~/.gnupg` is now treated like `~/.ssh` and `~/.aws`: reading a file in it, or packing or copying the folder, is refused. The `gpg` program using its own keyring is not affected.
- `cp -t DIR SRC`, `cp --target-directory=DIR SRC`, `mv -t` and `install -t` now check the sources: before, the last source was treated as the destination and skipped. `mv` and `install` are checked for folders too.
