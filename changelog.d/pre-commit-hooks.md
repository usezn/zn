### Added
- Hooks for the [pre-commit](https://pre-commit.com) framework: `zn-gate-scan` runs `zn-gate scan` and `zn-audit` runs `zn audit` on your repository before each commit. They need Node.js 18 or later. Each tag's hooks run the zn-gate version of that tag, not the latest one.
