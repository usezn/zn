# Example: the first ten minutes on macOS or Linux with a version-manager Node.js

A short walk-through for macOS or Linux when Node.js came from a version manager such as nvm. Every step comes from [First 5 minutes](../first-5-minutes.md) and the [troubleshooting guide](../troubleshooting.md). Run each command in your own terminal, not through your agent. For the full behaviour, read the [full page](../first-5-minutes.md).

1. Check your Node.js version:

   ```sh
   node --version
   ```

   Node.js 22 LTS is recommended. 18 or later works for the hooks and the CLI, and the Claude Code plugin needs 20.19 or later.

2. If the version is too old, update it with your version manager, then open a new terminal and check again. With nvm:

   ```sh
   nvm install --lts
   node --version
   ```

   If `npx: command not found` appears, Node.js is not installed or the terminal was opened before you installed it. Install Node.js, open a new terminal and try again ([troubleshooting 2](../troubleshooting.md#2-npx-command-not-found)).

3. Install zn-gate:

   ```sh
   npx -y zn-gate init
   ```

   `init` finds the coding agents on your machine, shows each step before it runs it, and asks first. You can say no. If it only prints steps and changes nothing, an agent or a script ran it: run it yourself in your own terminal ([troubleshooting 4](../troubleshooting.md#4-it-needs-you-at-your-own-terminal)).

4. If npm says `EACCES` while `init` installs zn-gate, do not use `sudo`. A Node.js version manager such as nvm normally avoids this, because it keeps Node.js in your home folder. Otherwise see [npm says EACCES](../troubleshooting.md#npm-says-eacces-when-init-installs-zn-gate).

5. Check that it worked:

   ```sh
   npx -y zn-gate check
   ```

   `OK` next to your agent means it is protected. A line that starts with `-` means zn is not set up for that agent, or the agent is not on your machine. A line with `NOT protected` says what to run. More in [check](../check.md).

6. If Claude Code says `NOT protected: the zn-gate plugin needs Node.js 20.19 or later`, Claude Code is probably starting a different, older `node`. Run `node --version` in the terminal you start Claude Code from. Make the newer Node.js the first `node` on your `PATH`, open a new terminal, start a new Claude Code session and run `check` again ([troubleshooting 11](../troubleshooting.md#11-the-claude-code-plugin-rejects-every-call-or-its-mcp-servers-show-failed-to-connect)).

7. Look at the version and run zn's built-in examples. They need no network, and `test` exits with `0` when all of them pass:

   ```sh
   npx -y zn-gate status
   npx -y zn-gate test
   ```

8. Work as usual. If zn blocks `cat .env`, read the reason, then run the command it names in your own terminal: `npx -y zn-gate env shadow .env`. See [secrets](../secrets.md).

9. If you are stuck, ask in [Discussions](https://github.com/usezn/zn/discussions). Give your zn-gate version (`zn-gate --version`), your operating system and the message, and leave out any secret.

To remove zn-gate, see [Remove zn-gate](../uninstall.md).
