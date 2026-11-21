# Example: what to run after you change Node.js (nvm, fnm, Homebrew)

Use this after you switch, upgrade or remove Node.js, for example with `nvm use`, `nvm uninstall`, fnm, a Homebrew Node.js upgrade or a new Node.js install. Every step comes from [Node.js was upgraded, moved or removed](../upgrading.md#nodejs-was-upgraded-moved-or-removed-nvm-fnm-homebrew) in the upgrading guide. Run each command in your own terminal, not through your agent. For what happens agent by agent, read the [full section](../upgrading.md#nodejs-was-upgraded-moved-or-removed-nvm-fnm-homebrew).

## Why a Node.js change matters

A user install of the hooks writes the paths of the Node.js and of the zn-gate files it was run from. A global npm package belongs to one Node.js version, so after the change the hook can point at something that is gone. What happens then depends on the agent and on how the hooks were installed; `zn-gate check` says which agents are in this state.

## Steps

Do these with the Node.js you want to keep.

1. Check which agents are not protected:

   ```sh
   npx -y zn-gate check
   ```

   It names each agent that is not protected and the command that fixes it. `npx` is used because the `zn` command may be gone with the old Node.js.

2. Usually the fix is to install zn-gate for the new Node.js and write the hooks again, once for each agent that `check` names:

   ```sh
   npm install -g zn-gate
   zn hooks install <agent>
   ```

   If you use Codex, open Codex and approve the changed hooks in `/hooks`. Until you do, Codex does not run them.

3. If you use the zn-gate plugin for Claude Code, make sure the Node.js you keep is 20.19 or later, then start a new Claude Code session.

4. Run the check again and confirm that each agent you use is protected:

   ```sh
   zn-gate check
   ```

## If you need your agent right away

Turn zn off for that agent until it is fixed:

```sh
npx -y zn-gate hooks uninstall <agent>
```

For the Claude Code plugin, use `claude plugin disable zn-gate@usezn` instead. Turn it back on with `zn hooks install <agent>` or `claude plugin enable zn-gate@usezn`, then run `zn-gate check` again.

## Related

- [Upgrading zn-gate](../upgrading.md)
- [If your agent blocks every prompt](../compat.md#if-your-agent-blocks-every-prompt)
- [What the output of check means](../check.md)
- [The first ten minutes on macOS or Linux with a version-manager Node.js](unix-first-run.md)
- [After an upgrade](after-an-upgrade.md)
