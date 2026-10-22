# Changelog fragments

Each pull request that changes what users get adds one file here instead of editing `CHANGELOG.md`, so pull requests merged one after another never conflict on the same lines. The release collects every fragment into its section of `CHANGELOG.md` and deletes them.

<!-- markdownlint-disable-next-line MD038 -->
Name the file after your branch, for example `changelog.d/fix-init-guard.md`. It holds only `### <Section>` headings and `- ` bullets, in the same words the changelog uses:

```markdown
### Fixed
- `zn-gate check` gives a repair that works after a Node.js version is removed.
```

Sections: Added, Changed, Deprecated, Removed, Fixed, Security. A bullet can go on over more lines when they start with two spaces.

The `Changelog` check fails a pull request that changes shipped files (the packages, the plugin, the Action) without a fragment, or that edits `[Unreleased]` in `CHANGELOG.md` by hand. A change users do not notice can take the `no-changelog` label instead.

Dependabot's dependency updates need no fragment; a security update gets one by hand.

To see what the next release will say: `node .github/scripts/changelog.mjs preview`. The release branch runs `node .github/scripts/changelog.mjs assemble --version X.Y.Z --date YYYY-MM-DD`, which also moves the compare links at the bottom; the short introduction of a release is written by hand after that, never in a fragment.
