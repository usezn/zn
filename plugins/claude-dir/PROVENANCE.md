# How this plugin is built and checked

This repository is generated from [usezn/zn](https://github.com/usezn/zn) by its "Plugin repository" workflow (`.github/workflows/plugin-repo.yml`), which runs `plugins/tools/build-plugin-repo.js` when usezn/zn's main branch pins the plugin to a new zn-gate release, and opens a pull request here. A maintainer merges it. Nothing here is edited by hand.

`scripts/zn-gate.lock.json` names the release (`version`) and the commit of usezn/zn it was generated from (`source`). You can check a release yourself with Node.js, Git and a recent GitHub CLI (with `gh attestation`):

1. Download the published package and check its integrity and provenance:

   ```
   npm pack zn-gate@X.Y.Z --ignore-scripts
   gh attestation verify zn-gate-X.Y.Z.tgz --repo usezn/zn \
     --signer-workflow usezn/zn/.github/workflows/release.yml --source-ref refs/tags/vX.Y.Z
   ```

   The sha512 integrity of the file must match `integrity` in `scripts/zn-gate.lock.json` and `npm view zn-gate@X.Y.Z dist.integrity`.

2. Unpack it and compare it with `vendor/zn-gate`: every file in `vendor/zn-gate` must be identical to the file with the same path under `package/`. The only files of the package that are left out are TypeScript sources and declarations (`.ts`, `.mts`, `.cts`) and source maps (`.map`).

3. Every SHA-256 in `scripts/zn-gate.lock.json` must match its file in `vendor/zn-gate`, and no other file may be there.

4. The `source` commit must be in usezn/zn's main branch and contain the tag `vX.Y.Z`. At that commit, these files must be identical to the ones here: `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`, `icon.png`, `LICENSE`, `scripts/zn-launch.js` and `skills/zn-secrets/SKILL.md` from `plugins/zn-gate/`; `README.md`, `SECURITY.md` and `PROVENANCE.md` from `plugins/claude-dir/`; and `.github/workflows/verify.yml`, which is `plugins/claude-dir/verify.yml`. `.gitattributes` contains only `* -text`, which keeps Git from changing line endings on checkout. No other file may be here, and every file has mode 644 (no links or executables).

The Verify workflow runs these checks on every pull request into `main` and on `main`, with `plugins/tools/verify-plugin-repo.js` from usezn/zn at the `source` commit. It runs as it is on `main`, so a pull request cannot change its own check. It also refuses a pull request that does not bring a newer version than `main`.
