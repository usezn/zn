# Install channels

zn-gate is published on npm and PyPI. The same version is on each channel. The Homebrew and Scoop
channels are planned but not available yet.

| Channel | Command | Status |
|---|---|---|
| npm | `npm install -g zn-gate`, or `npx -y zn-gate` without installing | Available |
| PyPI | `pip install zn-gate` (the Python package has a smaller command line; see [the Python package](cli.md#the-python-package)) | Available |
| Homebrew | `brew tap usezn/tap` then `brew install zn-gate` | **Not available yet.** The tap repository `usezn/homebrew-tap` does not exist yet. |
| Scoop | `scoop bucket add usezn https://github.com/usezn/scoop-bucket` then `scoop install zn-gate` | **Not available yet.** The bucket repository `usezn/scoop-bucket` does not exist yet. |

Until a channel is marked Available, do not use its command: it will fail. Use npm or PyPI.

## Homebrew (not available yet)

The formula is `packaging/homebrew/zn-gate.rb` in this repository. It installs the npm package
with Node.js, and `zn-gate --version` is its test. When the tap repository exists, the formula
is copied to `Formula/zn-gate.rb` there.

## Scoop (not available yet)

The manifest is `packaging/scoop/zn-gate.json` in this repository. It installs the npm package
with `nodejs-lts`, and it creates the `zn-gate`, `zn` and `zn-mcp` commands. When the bucket
repository exists, the manifest is copied to `bucket/zn-gate.json` there.
