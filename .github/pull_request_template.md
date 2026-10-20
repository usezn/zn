<!-- Pull requests target the `next` branch. See CONTRIBUTING.md and GOVERNANCE.md. -->

## What and why

<!-- What does this change, and why? Link the issue it closes, if any. -->

## Checklist

- [ ] The pull request targets `next`.
- [ ] Tests cover the change: `npm test` in `packages/zn-gate` and, if you touched the Python package, `python -m pytest tests/` in `packages/zn-gate-py`.
- [ ] New or changed rules are in both `packages/zn-gate/lib/rules.js` and `packages/zn-gate-py/src/zn_gate/rules.py`, with positive and negative test cases and no new false positives.
- [ ] I bumped the version of every rule layer I changed and ran `node packages/zn-gate/scripts/update-rules-snapshot.js`; I explain in this description any snapshot change without a version increase.
- [ ] A change users will notice has a fragment in `changelog.d/` (see `changelog.d/README.md`), and I did not edit `CHANGELOG.md` by hand.
- [ ] Documentation is updated (README, `docs/`), and runnable snippets still pass.
- [ ] No secrets, tokens, keys or personal data in the diff, commit messages or test fixtures.
- [ ] This is not a security vulnerability report. Those go through the [security policy](SECURITY.md), never a public pull request.
