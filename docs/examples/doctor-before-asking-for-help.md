# Checklist: what to run and paste before asking for help

Something does not work and you are about to ask in [Discussions](https://github.com/usezn/zn/discussions) or open an issue. Run the four commands below in your own terminal, not through your AI agent, and paste their output with your question. None of them sends anything or changes a setting.

1. **Is each agent protected?**

   ```bash
   npx -y zn-gate check
   ```

   The check tries to read a fake secret through every agent set up on this machine and prints one line per agent: `OK` when zn would stop it, `-` when zn is not set up for it, and `X` when zn is set up but would not protect it, with one fix to run. Its other name is `doctor`. On a new machine it exits with `1` until you have run `zn-gate init`. Every line is explained in [Check that it works](../check.md), and a full sample output line by line in [Example: reading a check output](check-output-explained.md).

2. **The same check, as one JSON object.**

   ```bash
   npx -y zn-gate check --json
   ```

   Made to paste into a support request: it has no secret values, and it writes your home folder as `~`. The field list is in [Machine-readable output](../check.md#machine-readable-output).

3. **Which version is installed, and is the cloud check on?**

   ```bash
   npx -y zn-gate status
   ```

   Prints the zn-gate version, the rules version, whether the optional cloud check is on and where the API key comes from. If an installed hook was written by an older zn-gate, it also prints the command that refreshes it. This command always exits with `0`.

4. **The version numbers as text.**

   ```bash
   npx -y zn-gate version
   ```

   Prints the version and the versions of the rules. `zn-gate --version` does the same.

Add the message you saw, your operating system, and what you did before it appeared. If a command ended with an error, the exit code can help too: the common ones are in [Exit codes](../cli.md#exit-codes).

## Leave secrets out of what you paste

`zn-gate check` runs with a fake key in a temporary folder and `zn-gate check --json` has no secret values, so their output is safe to paste. Everything else you send follows one rule: leave out any secret. Read the text once more and take out anything that looks like a key, a token or a passphrase before you post it.

## Related

- [Check that it works](../check.md)
- [Example: reading a check output line by line](check-output-explained.md)
- [Troubleshooting](../troubleshooting.md)
