# Recipes

Ten short recipes for the common jobs. Each one lists the steps and links to the full page. Run every command in your own terminal, not through an AI agent: several of them refuse to run under an agent. Every command is described in the [command line reference](cli.md).

## 1. Try zn-gate without installing it

1. Run `npx -y zn-gate check`.
2. Read the result. It uses a fake secret in a temporary folder, sends nothing and changes no setting.

Full page: [Check that it works](check.md).

## 2. Install zn-gate

1. Run `npm install -g zn-gate`.
2. Run `zn-gate version` to see that it is installed.
3. Run `zn-gate status` to see the version and whether the optional cloud check is on.

Full page: [First 5 minutes](first-5-minutes.md).

## 3. Set up your coding agents

1. Run `zn-gate init`.
2. Read what it found on this machine and answer each question. It asks before each step.
3. Run `zn-gate check` (recipe 4) when it is done.

Full page: [First 5 minutes](first-5-minutes.md), and [`init`](cli.md#init) in the reference.

## 4. Check that you are protected

1. Run `zn-gate check`.
2. Every agent that is set up should say **OK**. The command exits `0` in that case.
3. If a line says **NOT protected**, run the command that the line prints.

Full page: [Check that it works](check.md).

## 5. See what your agents can reach

1. Go to the project folder.
2. Run `zn-gate reach`. It lists secret names, credential files and MCP servers. It is read only and sends nothing.
3. Add `--json` if you want the result for another program.

Full page: [Reach](reach.md).

## 6. Protect one project

1. Go to the project folder.
2. Run `zn-gate hooks install claude-code --project`. Use the name of your agent in place of `claude-code` (see the list in [`hooks`](cli.md#hooks)).
3. Run `zn-gate check` to confirm.
4. To remove these hooks again, run `zn-gate hooks uninstall claude-code --project`.

Everyone who uses the project needs zn-gate installed globally, because the shared files run `zn` from the PATH.

Full page: [Editors and coding agents](editors/README.md), and [`hooks`](cli.md#hooks) in the reference.

## 7. Turn on the optional cloud check

1. Run `zn-gate connect`.
2. Create an analysis-only API key in the browser page it opens.
3. Paste the key at the hidden prompt. Never put the key on the command line.
4. To turn it off later, run `zn-gate disconnect`.

Without this, nothing leaves your machine.

Full page: [Connect](connect.md).

## 8. Read the weekly report

1. Run `zn-gate report`. It covers the last 7 days.
2. For a longer period, use `--since`, for example `zn-gate report --since 30d`.
3. Add `--json` for a machine-readable version.

The report is built from local files and nothing is sent.

Full page: [Report](report.md).

## 9. Upgrade

1. Run `npm install -g zn-gate`. With the Python package, also run `pip install -U zn-gate`.
2. Look up your old and new versions in the table of the upgrading page. Most releases need nothing more.
3. Run `zn-gate check`. If an agent is not protected, it prints the command that fixes it.

Full page: [Upgrading](upgrading.md).

## 10. Uninstall

1. Run `zn-gate uninstall --dry-run` to see the plan. Nothing changes.
2. Run `zn-gate uninstall` and confirm in your terminal. The vault stays unless you answer yes to the separate question about it.
3. Run `npm uninstall -g zn-gate` to remove the program itself.

Full page: [Remove zn-gate](uninstall.md).
