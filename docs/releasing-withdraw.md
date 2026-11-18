# Withdrawing a bad zn-gate release

What to do when a published zn-gate version is bad: it breaks installs, it ships a vulnerability, or it carries the wrong files. The steps are in the order that stops the most users first. Each one has the exact command, who runs it and how to undo it.

Nothing here deletes a version. npm allows an unpublish only in the first 72 hours, and a deleted version breaks everyone who pinned it, including the agent plugin, the MCP Registry entry and the GitHub Action. A withdrawal marks the version as bad and sends new installs to a good one.

## Who does what

- **The maintainer with the publishing identity** runs every command below, from the machine that holds the publishing login (npm with two-factor authentication, PyPI, GitHub as the `tljohnsilver` account). Contributors and automated coding sessions never run them.
- **The project owner** gives the GO before anything public changes. A withdrawal changes public state, so it is never started on a hunch.
- **The person who maintains the website** changes the version shown on the site (step 7). The hand-off is a message with the facts of [step 7](#7-website-and-docs), not a shared login.

## Fixed release or withdrawal

A fast fixed release is better than a withdrawal when the fix is ready within hours, because users on the bad version move to the fix with one update and nothing needs to be undone. Withdraw first when users are being harmed now and the fix needs longer.

| Situation | Do this |
|---|---|
| Vulnerability with CVSS 7.0 or higher, fix ready the same day | Publish the fix from a `release/X.Y.Z` branch made from `main` ([release process](../GOVERNANCE.md#releases)). Deprecate the bad version (step 2) as soon as the fix is public. |
| Vulnerability with CVSS 7.0 or higher, fix needs more than a day | Withdraw now (steps 1 to 6), then ship the fix. |
| Installing or starting zn-gate is broken | Withdraw now if `latest` is the broken version (step 1), then ship the fix. |
| Wrong files, wrong notes or a wrong web page, and the package works | Fix the notes or the page. Do not withdraw. |
| Medium or low severity issue | No withdrawal. It goes into the next weekly release with its advisory. |
| A release candidate is bad | Move `next` back (step 1) and publish the next candidate. Do not touch the other steps. |

If the bad version is a security issue, read [step 8](#8-security-issues) before writing anything public.

## Before you start

Write down the bad version, the last good version and why. Then read the live state. These commands change nothing:

```sh
npm dist-tag ls zn-gate
npm view zn-gate versions --json
gh release list --repo usezn/zn --limit 5
gh api repos/usezn/zn/releases/latest --jq .tag_name
curl -fsS https://pypi.org/pypi/zn-gate/json
curl -fsS "https://registry.modelcontextprotocol.io/v0/servers/io.github.usezn%2Fzn-gate/versions"
```

The PyPI answer lists each file with a `yanked` field. The registry answer lists each version with its `status` and `isLatest`.

## 1. Point `latest` back to the good version

This stops new installs of the bad version. Run it only if `latest` is the bad version.

```sh
npm dist-tag add zn-gate@GOOD_VERSION latest --otp=CODE
npm dist-tag ls zn-gate
```

Replace `GOOD_VERSION` with the last good version and `CODE` with the current code of your authenticator app. For a bad release candidate, move `next` instead: `npm dist-tag add zn-gate@GOOD_RC next --otp=CODE`.

The release workflow never moves `latest` backward ([`npm-dist-tag-plan.mjs`](../.github/scripts/npm-dist-tag-plan.mjs)), so this step is always manual. Undo: run the same command with the bad version.

## 2. Deprecate the bad npm version

Deprecating keeps the version installable by anyone who pins it and shows your message to everyone who installs it.

```sh
npm deprecate zn-gate@BAD_VERSION "Known issue. Upgrade to GOOD_OR_FIXED_VERSION." --otp=CODE
npm view zn-gate@BAD_VERSION deprecated
```

Keep the message short and free of exploit details (see step 8). Check with `npm help deprecate` whether your npm version lists `--dry-run`; if it does, run the command once with it before the real one. Undo: the same command with an empty message, `npm deprecate zn-gate@BAD_VERSION ""`.

## 3. Yank the PyPI release

PyPI has no yank through an API call, and the trusted publisher the release workflow uses can only upload. A yank is done on the website, signed in as an owner of the project, with two-factor authentication:

1. Open the project's *Manage* page on pypi.org, then *Releases*.
2. Open the options of `BAD_VERSION` and choose *Yank*.
3. Enter a reason (it is shown to users) and confirm.

A yanked release is skipped by `pip install zn-gate` and by version ranges, and stays installable with an exact pin (`zn-gate==BAD_VERSION`). Check it with `curl -fsS https://pypi.org/pypi/zn-gate/BAD_VERSION/json` and read `yanked`. Undo: *Unyank* in the same menu.

## 4. Mark the GitHub Release

```sh
gh release edit vBAD_VERSION --repo usezn/zn --prerelease
gh release edit vGOOD_VERSION --repo usezn/zn --latest
gh api repos/usezn/zn/releases/latest --jq .tag_name
```

The last command must print the good tag. Do not move the bad release back to draft: its files, `SHA256SUMS` and signatures disappear and [`verify-release.sh`](../scripts/verify-release.sh) fails for that version, which hides the evidence users need. Add a short warning at the top of its notes with `gh release edit vBAD_VERSION --repo usezn/zn --notes-file warning.md` (write the file from the current notes first). Never delete or move the tag: tags are signed and protected.

Undo: `gh release edit vBAD_VERSION --repo usezn/zn --prerelease=false --latest`.

## 5. MCP Registry

The `MCP Registry` workflow ([`mcp-registry.yml`](../.github/workflows/mcp-registry.yml)) can only publish the `server.json` of a tag. To change the status of an existing version, use the registry tool with an interactive GitHub login as a maintainer:

```sh
mcp-publisher login github
mcp-publisher status --status deprecated --message "Known issue. Upgrade to GOOD_OR_FIXED_VERSION." io.github.usezn/zn-gate BAD_VERSION
```

Use `--status deleted` only for a version that is dangerous to keep listed. Undo: `mcp-publisher status --status active io.github.usezn/zn-gate BAD_VERSION`. Use the same `mcp-publisher` version the workflow pins. Clients start the server as `zn-gate@<version> mcp`, so a registry entry that stays on the bad version keeps sending new users to it: if the bad version is the registry's latest, the fix is to publish the fixed version with the `MCP Registry` workflow as soon as its npm package is public.

## 6. Plugin pin and marketplace

The plugin is pinned to an exact npm version in `plugins/zn-gate/scripts/zn-gate.lock.json` and in the plugin manifests. The marketplace files (`.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `plugins/zcode/marketplace.json`) carry no version, so they need no change.

If the plugin on `main` is pinned to the bad version, open a pull request into `main` that re-pins it:

```sh
node plugins/tools/pin-release.js GOOD_VERSION
node plugins/tools/check-plugins.js
```

`main` accepts a plugin pinned to any published release, so the last good one passes. Bump the plugin manifests in the same pull request, as for a release. If a fixed release is coming within a day, pin the plugin to the fix instead. Undo: pin the bad version again, which is only right after it is fixed.

Also check the places that pin an exact version and may name the bad one: `.pre-commit-hooks.yaml`, the examples, and the version in [`.github/public-facts.json`](../.github/public-facts.json). They change together in one pull request, because the `Public facts` check fails when they disagree.

## 7. Website and docs

The website is a separate package that the site maintainer deploys; nobody else changes it. Send that person one message with:

- the bad version, the good version and the time `latest` moved;
- the exact text for the version pill (it names the latest version that is safe to install, so it shows the good version until the fix is public);
- any number that came from the bad version (agents supported, rule counts, performance figures) and what it must say now;
- whether the change is a security issue (the web copy then waits for the advisory, step 8);
- that the text changes in all five languages in the same deploy.

Deploy the web change in the same hour as steps 1 to 4, so the site, npm and the GitHub Release say the same version. The documentation in this repository goes through a pull request as usual. A security or breaking withdrawal also gets a line in `CHANGELOG.md` ([`Security`](../changelog.d/README.md) or `Fixed`) in the fix release.

## 8. Security issues

When the bad version has a vulnerability:

1. Keep the technical details private. The withdrawal messages in steps 2 to 5 say only "known issue, upgrade to X".
2. Open a draft GitHub Security Advisory with the affected versions and the fixed version ([SECURITY.md](../SECURITY.md#reporting-a-vulnerability)). Steps 1 to 5 may go ahead before it is published, since they reveal nothing.
3. Ship the fix from a `release/X.Y.Z` branch made from `main`, with only the fix, and publish the advisory, the release notes and the changelog entry together. SECURITY.md lists the new advisory (the repository checks that the list matches).
4. After the advisory is public, update the deprecation messages if they should link to it.

## 9. Tell people

Keep one message, in English, with the same facts everywhere: which version, what the problem is in one sentence (no exploit details), which version to use, and how to move (`npm install -g zn-gate@GOOD_VERSION`, `pip install zn-gate==GOOD_VERSION`). Post it as the note at the top of the bad GitHub Release, in the deprecation message and, for a security issue, in the advisory. Posts on other channels need the project owner's explicit approval of the exact text, and use the project's public identity only.

## After the withdrawal

Run the read-only checks from "Before you start" again and compare with the steps you took. When the fixed release is out, run `scripts/verify-release.sh` for it and close the withdrawal: remove nothing, and keep the notes on the bad version as they are.

## Rehearsal

Rehearse the procedure after a change to the release process and at least once a quarter, with read-only commands only, on the machine that will run the real ones:

1. Run every command of "Before you start" and check that it prints what the live state is. A command that fails here fails on the day.
2. Check that `npm whoami` prints the publishing account (it must be logged in with two-factor authentication) and that `gh auth status` shows the `tljohnsilver` account. If either is missing, fix the login now.
3. Run `npm deprecate` with `--dry-run` if your npm lists it, and read the help of `gh release edit` and `mcp-publisher status --help` to confirm the flags above still exist.
4. Open the PyPI *Manage* page and check that the owner account can see *Yank* in the release options. Do not click it.
5. Run `node plugins/tools/check-plugins.js` on a clean checkout of `main`.
6. Send the website maintainer the message of step 7 with the current versions, marked as a rehearsal, and check that they can find the version pill and its translations.

Do not run a real publish, deprecate, yank, dist-tag change or release edit in a rehearsal, and never on the current `latest`.
