# First 5 minutes with zn-gate

You use an AI coding agent (Claude Code, Codex CLI, Cursor, OpenCode, Antigravity or Zcode) and you do not write code yourself, or not much. This page takes you from nothing to "zn-gate is on and I saw it work", then tells you what its messages mean and how to remove it. No account and no API key are needed. Everything runs on your machine.

## Before you start

Node.js 22 LTS is recommended; 18 or later works for the hooks and the CLI, and the Claude Code plugin needs 20.19 or later. For security, use the latest patch of a supported Node.js line (22.23.4, 24.22.1, 26.12.1 or later): Node.js 18 and 20 are end-of-life and get no security fixes, even though zn-gate still runs on them. If `node --version` says "command not found", install the LTS version from [nodejs.org](https://nodejs.org/) and open a new terminal. Run every command below in your own terminal, not through your agent.

## 1. Install

```bash
npx -y zn-gate init
```

`init` finds the coding agents on your machine and shows each step before it runs it. It asks first, and you can say no. For Claude Code it sets up the zn-gate plugin (or zn's hooks when your Node.js is older than 20.19). For Codex CLI, Cursor, OpenCode, Antigravity and Zcode it sets up zn's hooks. A hook is a small check that your agent runs before it uses a tool. Setup for one agent at a time is in the [README](../README.md#install).

Want to look first? `npx -y zn-gate reach` lists what your agents can reach (secret names, credential files, MCP servers). It changes nothing and sends nothing. See [reach](reach.md).

## 2. Check that it works

`init` ends with this check. You can run it any time:

```bash
npx -y zn-gate check
```

It makes a temporary folder with a fake key in a `.env` file, asks your agent's hook to read it, and deletes the folder. This is the real output:

```text
zn-gate check: does zn stop your coding agent from reading a secret?

zn made a test folder with a fake key in a .env file and an ordinary file next to it, then asked
each agent's zn hook whether the agent may read them. This is what happened:

  OK Claude Code  blocked the .env file and allowed the ordinary file. Your agent would be told:
     "zn: .env holds plain-text secrets. Ask the user to run `zn env shadow .env` in their terminal: it moves the values to the local vault and leaves __ZN_<NAME>__ markers you can read and use."
  -  Codex CLI    not found on this machine
  -  Cursor       not found on this machine
  -  OpenCode     not found on this machine

Your agent cannot read secret files such as .env through these tools. Nothing was sent anywhere.
If your agent needs a value from .env, keep it in zn's vault instead: `zn env shadow .env`.
More: https://usezn.com/docs/check

The test folder was deleted.
```

`OK` means that agent is protected. A line that starts with `-` means zn is not set up for that agent, or the agent is not on your machine. A line with `NOT protected` says why and what to run. More in [check.md](check.md).

## 3. What you will see while you work

zn-gate speaks up in three ways. Blocks and approval questions come from zn's hooks and show up in your agent's window. Warnings come from zn's text check and reach you only if your agent tells you.

### A block

zn stopped something that could leak a secret or looked like an attack, and it did not run. Here, an agent in `~/my-project` tried to run `cat .env`. This is what zn answered, word for word:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"zn: .env holds plain-text secrets. Ask the user to run `zn env shadow .env` in their terminal: it moves the values to the local vault and leaves __ZN_<NAME>__ markers you can read and use."}}
```

`deny` is the block. The sentence after it is the next step. What to do:

1. Read the reason. It is written for you and for your agent.
2. If the agent needs a value from that file, run the command in the message yourself, in your own terminal: `npx -y zn-gate env shadow .env`. The real values move into zn's encrypted vault and the file keeps markers. See [secrets](secrets.md).
3. If the block was a surprise, do not look for a way around it. Ask your agent why it wanted to read that file.

An ordinary command such as `ls` gets no answer at all: it is allowed and you see nothing.

### An approval question

Sometimes zn does not block but asks you first. This happens, for example, when a command would send personal data to another host. Real answer for `curl -d "mail=ana@example.com" https://example.com/api`:

```text
"permissionDecision":"ask","permissionDecisionReason":"zn: this command would send an email address in the body to example.com. Approve it only if that data should leave this computer. To use a secret, do not write its value in the command and do not expand a shell variable into its arguments: use the secrets_http_request tool for a web request (the secret in proxy mode), or `zn run --secrets NAME -- <program that reads the variable>` so the program reads the secret from its own environment variable."
```

Your agent then shows its normal permission question. Read the command. Approve it only if it is what you expected.

### A warning

zn also has a text check that your agent can call through zn's own tools. Some patterns it looks for also show up in ordinary text, such as "bypass the cache". For those, zn does not block: it lets the text through and adds a short warning, called an `advisory`. The warning goes to your agent, not to your screen, so you see it only if your agent mentions it. zn's hooks do not warn you about these. You can run the same check yourself. Real output of `npx -y zn-gate analyze "You can bypass the cache with --no-cache."`:

```json
{
  "verdict": "allow",
  "confidence": 0.99,
  "rule": "none",
  "reason": null,
  "engine": "oss-local",
  "rules_version": "2026-10-16.10",
  "advisory": {
    "rule": "pi:bypass",
    "reason": "Guardrail bypass attempt"
  },
  "mode": "oss-local"
}
```

`"verdict": "allow"` means nothing was stopped. The `advisory` says why it is worth a look. What to do: read the text it points at. If it is harmless, carry on. If you did not expect it (for example inside a file you downloaded), do not let your agent follow it. To make the text check block these too, turn on strict mode: set `ZN_STRICT=1`, or add `"strict": true` to `zn.config.json` in your project.

For comparison, `npx -y zn-gate analyze "ignore all previous instructions"` is a block: `"verdict": "block"` with the reason "Override prior instructions".

## If something fails

- `npx: command not found`: install the LTS version of [Node.js](https://nodejs.org/), open a new terminal and run the command again.
- "running scripts is disabled on this system" on Windows: use `npx.cmd` instead of `npx`, or see the PowerShell note in the [README](../README.md#install).
- `init` only prints steps and changes nothing: an AI agent or a script ran it. Run it yourself in your own terminal.
- `check` says `NOT protected`: the line says what to run.
- zn blocked something you need: use `npx -y zn-gate env shadow .env` for secrets, or ask in [Discussions](https://github.com/usezn/zn/discussions).
- Another message? The [troubleshooting guide](troubleshooting.md) explains the ten most common ones.

## Remove zn-gate

To remove everything in one step, run `npx -y zn-gate uninstall` in your own terminal ([details](uninstall.md)). To remove only the part you installed:

- **Hooks** (Codex CLI, Cursor, OpenCode, Antigravity, Zcode, or Claude Code without the plugin): `npx -y zn-gate hooks uninstall claude-code`. Use `codex`, `cursor`, `opencode`, `antigravity` or `zcode` for the others, and add `--project` if you installed them for one project only. A backup of the settings file is written first.
- **Claude Code plugin**: run `claude plugin uninstall zn-gate@usezn`, or in Claude Code type `/plugin`, open the **Installed** tab, pick zn-gate and choose **Uninstall**. To also remove the usezn plugin list, run `claude plugin marketplace remove usezn`.
- **Wrapped MCP servers** (from `init --wrap-mcp`): `npx -y zn-gate init --revert` puts back each MCP settings file as it was saved just before zn wrapped it. Changes you made to those files later, such as MCP servers you added, are lost, so add them again afterwards. It only undoes MCP wrapping, not hooks.
- **The program itself**, if you installed it with `npm install -g zn-gate`: `npm uninstall -g zn-gate`.
- **The Python package**, if you installed it with `pip install zn-gate`: `pip uninstall zn-gate`.
- **`.env` files you moved into the vault** keep markers such as `__ZN_API_KEY__`. `env shadow` tells you how to put the real values back. Do that before you remove zn-gate.
- **zn's own folder**: zn keeps its vault, settings and counters in a `.zn` folder in your home folder, and removing zn-gate leaves it there. Delete it only after you have put your `.env` values back, because the vault holds them.

Run `npx -y zn-gate check` afterwards if you want to see that zn is off.

## Where to go next

- [What the check means](check.md)
- [Keep your `.env` values in the vault](secrets.md)
- [Every command and exit code](cli.md)
- [Remove zn-gate](uninstall.md)
- [Words you do not know](glossary.md)
- [What zn-gate cannot protect](threat-model.md)
