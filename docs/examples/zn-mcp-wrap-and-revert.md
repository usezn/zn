# Wrap an MCP server, then undo it

`zn-gate init --wrap-mcp` puts the `shield` in front of the MCP servers that
your coding agents start. This example wraps one made-up server, checks the
change, and puts the original config back. The server name and paths are made
up.

## What the wrap changes

```bash
zn-gate init --wrap-mcp --dry-run
```

`--dry-run` prints what would change and changes nothing
(`docs/cli.md`, `init`). Without it, the command:

1. finds the MCP servers in the config files of the known agents;
2. writes a backup of each config file first, named `<file>.bak.<milliseconds>`
   in the same folder (`packages/zn-gate/lib/init.js:636-637`);
3. rewrites the server entry so that it starts through `shield`.

Use `--shadow` to wrap in shadow mode. In that mode problems are logged, but
nothing is dropped (`docs/cli.md`, `init`).

Check the result with the usual check:

```bash
zn-gate check
```

## Undo it with `--revert`

Run this in your own terminal, not through an agent:

```bash
zn-gate init --wrap-mcp --revert --dry-run
zn-gate init --wrap-mcp --revert
```

`--revert` puts back the newest backup of each config (`packages/zn-gate/lib/init.js:548-551`, `605-616`).

- The backup must be in the same folder as the config. A backup that is not
  there is not used (`packages/zn-gate/lib/init.js:607-610`, the `--dry-run`
  check).
- If a config has wrapped servers but no backup, zn leaves it as it is and
  reports that no backup was found (`packages/zn-gate/lib/init.js:618-619`).
  Remove the `shield` wrapper by hand in that case.
- `--revert` does not remove the Claude Code plugin, the hooks or the `.env`
  markers. For those, use `uninstall` (`docs/cli.md`, `init`).

Note that a restore replaces the whole config file with the saved copy. Any
change you made to that file after the wrap is lost (`docs/cli.md`, `uninstall`).

## Undo it with `uninstall`

```bash
zn-gate uninstall --dry-run
zn-gate uninstall
```

`uninstall` lists the wrapped configs under "MCP servers wrapped by
zn-gate init --wrap-mcp". For each one it puts back the saved copy, and only
then removes the hooks and the plugin (`packages/zn-gate/lib/uninstall.js:132-137`,
`215-223`). After that it looks again. A config that is still wrapped, for
example one that was wrapped twice, is listed with the instruction to open the
file and put the original command of each server back by hand
(`packages/zn-gate/lib/uninstall.js:246-251`).

`uninstall` also removes the hooks and the plugin, and it asks about the vault
separately. If you only want the MCP servers back, use `--revert` instead.

## Exit codes

From `docs/cli.md`, `init`:

- `0`: done, or every agent found is already protected;
- `1`: no supported agent was found, or the steps were only printed;
- `2`: an argument zn does not know.

## Related pages

- [init-and-uninstall.md](init-and-uninstall.md): the guided setup and the full removal.
- [shield-walkthrough.md](shield-walkthrough.md): wrap a fake MCP server with the shield, from shadow mode to enforce and back.
- [shield-first-run.md](shield-first-run.md): the first run of the shield in shadow mode.
