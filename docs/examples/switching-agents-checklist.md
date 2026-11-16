# Checklist: switching from one agent to another

Use this when you stop using one coding agent and start using another, and you want zn-gate to protect the new one. Run every command in your own terminal, not through an agent. None of this changes your code.

The example moves from Codex CLI to Cursor. For other agents, use the names in [Install, verify and uninstall by agent](../by-agent.md).

1. **Check the current setup.**

   ```bash
   npx -y zn-gate check
   ```

   You should see that the hook blocks the fake `.env` file. See [Check that it works](../check.md).

2. **Uninstall zn's hooks for the old agent.**

   ```bash
   npx -y zn-gate hooks uninstall codex
   ```

   Add `--project` if you installed them for one project only, and run the command from that project's folder. A backup of the settings file is written first. For Claude Code with the plugin, use `claude plugin uninstall zn-gate@usezn` instead. More: [Remove zn-gate](../uninstall.md#piece-by-piece).

3. **Install zn's hooks for the new agent.**

   ```bash
   npx -y zn-gate hooks install cursor
   ```

   Some agents need one more step, such as trusting the hook in `/hooks` for Codex CLI. Check the row for your agent in [by-agent.md](../by-agent.md), or its page under [editors](../editors/README.md).

4. **Check again.**

   ```bash
   npx -y zn-gate check
   ```

   It should report that the new agent's hook blocked the fake `.env` file.

Your vault and your settings in the `.zn` folder stay in place, so you do not need to set them up again. If you want to remove everything instead, run `npx -y zn-gate uninstall`: see [Remove zn-gate](../uninstall.md).

## Related

- [Remove one agent's hooks](uninstall-one-agent.md)
- [Install, verify and uninstall by agent](../by-agent.md)
