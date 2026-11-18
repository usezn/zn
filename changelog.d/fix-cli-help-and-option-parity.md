### Fixed
- `zn-gate scan` now refuses `--key`, `--stage`, `--url`, `--local-only` and `--long-input` with exit code 2, as the Python package does: scan never uses the cloud, so these options were ignored without a word.
- The general help of the npm package now names the aliases `wrap`, `export` and `secrets` and the `-v` and `--version` forms, and a test keeps it in line with `docs/cli.md`.
- The help of the Python package now says that the other commands (init, hooks, secret, vault, shield, team and more) are in the npm package and shows how to run `npx -y zn-gate --help`.
