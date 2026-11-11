# First 5 minutes with zn-gate

You use an AI coding agent (Claude Code, Codex CLI, Cursor, OpenCode, Antigravity, ZCode desktop app or GitHub Copilot, or the experimental Gemini CLI) and you do not write code yourself, or not much. This page takes you from nothing to "zn-gate is on and I saw it work", then tells you what its messages mean and how to remove it. No account and no API key are needed. Everything runs on your machine.

## The three commands

> **Before you run them**
>
> - An agent must already be installed before `npx -y zn-gate init`: see [Install your agent first](#install-your-agent-first).
> - Run the commands in your own terminal, not through your agent.
> - On Windows PowerShell, use the `.cmd` forms (`npx.cmd`) or set the execution policy: see the [PowerShell note](#install-your-agent-first) and the [.cmd forms](#windows-powershell-the-cmd-forms).

Run these in your own terminal, not through your agent. You need Node.js first; its details are [below](#before-you-start).

1. **Install:** `npx -y zn-gate init`
2. **Check:** `npx -y zn-gate check`
3. **Next, if you have a `.env` file with real secrets:** `npx -y zn-gate env shadow .env`

Each step is explained below. Windows PowerShell notes are in [Install your agent first](#install-your-agent-first).

## 1. Install

```bash
npx -y zn-gate init
```

`init` finds the coding agents on your machine and shows each step before it runs it. It asks first, and you can say no. For Claude Code it sets up the zn-gate plugin (or zn's hooks when your Node.js is older than 20.19). For Codex CLI, Cursor, OpenCode, Antigravity, ZCode desktop app, GitHub Copilot and the experimental Gemini CLI it sets up zn's hooks. A hook is a small check that your agent runs before it uses a tool. Setup for one agent at a time is in the [README](../README.md#install).

Want to look first? `npx -y zn-gate reach` lists what your agents can reach (secret names, credential files, MCP servers). It changes nothing and sends nothing. See [reach](reach.md).

## 2. Check that it worked

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
     "zn: .env holds plain-text secrets, and secret values never go to the model (rule: secret-file:dotenv). Ask the user to run `zn env shadow .env` in their terminal: it moves the values to the local vault and leaves __ZN_<NAME>__ markers you can read and use."
  -  Codex CLI    not found on this machine
  -  Cursor       not found on this machine
  -  OpenCode     not found on this machine
  -  Antigravity  not found on this machine
  -  GitHub Copilot (VS Code, CLI) not found on this machine
  -  Gemini CLI (experimental) not found on this machine
  -  ZCode        not found on this machine

Your agent cannot read secret files such as .env through these tools. Nothing was sent anywhere.
If your agent needs a value from .env, keep it in zn's vault instead: `zn env shadow .env`.
More: https://usezn.com/docs/check

The test folder was deleted.

Decision time per tool call: no data yet. It is measured on each tool call your agent makes through zn.
```

The `Decision time per tool call` line is the time zn takes to decide each tool call your agent makes on this machine, as the p50 and p95 of the calls it has measured recently. It says `no data yet` until zn has checked a tool call. [What you will see](check.md#what-you-will-see) explains it.

`OK` means that agent is protected. A line that starts with `-` means zn is not set up for that agent, or the agent is not on your machine. A line with `NOT protected` says why and what to run. More in [check.md](check.md).

Two more commands from the [command line reference](cli.md) help if you want to be sure:

```bash
npx -y zn-gate status
npx -y zn-gate test
```

`status` shows the version and the rules version. `test` runs zn's built-in examples on your machine, without the network, and exits with `0` when all of them pass. If `check` says `NOT protected`, or `test` reports a failed example, run `npx -y zn-gate init` again and then repeat the check.

## 3. What you will see while you work

zn-gate speaks up in three ways. Blocks and approval questions come from zn's hooks and show up in your agent's window. Warnings come from zn's text check and reach you only if your agent tells you.

### A block

zn stopped something that could leak a secret or looked like an attack, and it did not run. Here, an agent in `~/my-project` tried to run `cat .env`. This is what zn answered, word for word:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"zn: .env holds plain-text secrets, and secret values never go to the model (rule: secret-file:dotenv). Ask the user to run `zn env shadow .env` in their terminal: it moves the values to the local vault and leaves __ZN_<NAME>__ markers you can read and use."}}
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
  "rules_version": "2026-11-07.1",
  "advisory": {
    "rule": "pi:bypass",
    "reason": "Guardrail bypass attempt"
  },
  "mode": "oss-local"
}
```

`"verdict": "allow"` means nothing was stopped. The `advisory` says why it is worth a look. What to do: read the text it points at. If it is harmless, carry on. If you did not expect it (for example inside a file you downloaded), do not let your agent follow it. To make the text check block these too, turn on strict mode: set `ZN_STRICT=1`, or add `"strict": true` to `zn.config.json` in your project.

For comparison, `npx -y zn-gate analyze "ignore all previous instructions"` is a block: `"verdict": "block"` with the reason "Override prior instructions".

## Before you start

> **Checklist**
>
> - **Node.js:** Node.js 22 LTS is recommended (from [nodejs.org](https://nodejs.org/)). Node.js 18 or later works for the hooks and the CLI; the Claude Code plugin needs 20.19 or later.
> - **An agent:** at least one of Claude Code, Codex CLI, Cursor or OpenCode. Antigravity is experimental.
> - **No account and no API key** are needed.

Node.js 22 LTS is recommended (from [nodejs.org](https://nodejs.org/)). Node.js 18 or later works for the hooks and the CLI; the Claude Code plugin needs 20.19 or later. For security, use the latest patch of a supported Node.js line (22.23.4, 24.22.1, 26.12.1 or later): Node.js 18 and 20 are end-of-life and get no security fixes, even though zn-gate still runs on them. If `node --version` says "command not found", install the LTS version from [nodejs.org](https://nodejs.org/) and open a new terminal. Run every command on this page in your own terminal, not through your agent.

On Debian or Ubuntu Linux, `sudo apt install nodejs` can install an old Node.js (Ubuntu 22.04 ships version 12): run `node --version` and, if it is older than 18, install a current Node.js from [nodejs.org](https://nodejs.org/) or the NodeSource packages. Gemini CLI and the Claude Code plugin need an even newer one. For example, with the NodeSource packages for Node.js 22 LTS:

```bash
sudo apt-get install -y curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

`node --version` should print `v22` followed by numbers. On another Linux system, download Node.js 22 LTS from [nodejs.org](https://nodejs.org/en/download).

## Install your agent first

> **Windows PowerShell:** if a command says "running scripts is disabled on this system", run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once in PowerShell, or use `npx.cmd` in place of `npx` (or run the commands in Command Prompt). More in [troubleshooting](troubleshooting.md#3-running-scripts-is-disabled-on-this-system-windows).

zn-gate protects an agent that is already installed; it does not install the agent for you. Install the agent from its official site, and sign in with your own account for that agent (zn-gate itself needs no account):

- Codex CLI: run `npm install -g @openai/codex`, then run `codex` and sign in with your OpenAI account. OpenAI's own steps are in the [Codex CLI docs](https://developers.openai.com/codex/cli).
- Gemini CLI: run `npm install -g @google/gemini-cli` (it needs Node.js 20 or later), then run `gemini` and sign in with your Google account. Google's own steps are in the [Gemini CLI repository](https://github.com/google-gemini/gemini-cli).

If `npm install -g` fails with `EACCES`, use the fix in Troubleshooting, then run the same `npm install -g` command again.

## Windows PowerShell: the .cmd forms

On Windows, PowerShell can refuse to run the `npx.ps1` and `zn.ps1` scripts that npm writes next to the programs, and then a bare `npx` or `zn` fails with "running scripts is disabled on this system". The `.cmd` forms start the same programs without those scripts. Use them when a bare command fails this way:

```powershell
npx.cmd -y zn-gate init
npx.cmd -y zn-gate check
```

After `npm.cmd install -g zn-gate`, the installed program is `zn.cmd`:

```powershell
zn.cmd check
zn.cmd status
```

On Windows, zn prints the `.cmd` form in its own messages, so copy the command it shows. The execution policy note above is a permanent fix; the `.cmd` forms need no change to your settings. If `npx.cmd` or `zn.cmd` says it is not recognized, the folder where npm installs programs is not on PATH: see [troubleshooting](troubleshooting.md#3-running-scripts-is-disabled-on-this-system-windows).

## If something fails

- `npx: command not found`: install the LTS version of [Node.js](https://nodejs.org/), open a new terminal and run the command again.
- "running scripts is disabled on this system" on Windows: use `npx.cmd` instead of `npx`, or see the PowerShell note in the [README](../README.md#install).
- `init` only prints steps and changes nothing: an AI agent or a script ran it. Run it yourself in your own terminal.
- `check` says `NOT protected`: the line says what to run.
- zn blocked something you need: use `npx -y zn-gate env shadow .env` for secrets, or ask in [Discussions](https://github.com/usezn/zn/discussions).
- Another message? The [troubleshooting guide](troubleshooting.md) explains the eighteen most common ones.

## Remove zn-gate

To remove most of it in one step, run `npx -y zn-gate uninstall` in your own terminal ([details](uninstall.md)). It does steps 1, 2 and 3 below for you, in that order, after you confirm the list, and deletes the launcher scripts in `~/.zn/hooks`. It then asks separately before it deletes the vault (the second question, part of step 5), runs `zn-gate check`, and prints the program removal as its last line. It does not edit your `.env` files (step 4), does not delete the rest of the `.zn` folder (step 5) and does not remove the program, so step 4, the rest of step 5, step 6 and step 7 are yours to do.

To remove one part at a time, go in this order: wrapped MCP servers first, then the hooks, then the plugin, and the program last. This is the order `zn-gate uninstall` uses. If you remove the program first, your agent's settings still point at a command that is gone.

1. **Wrapped MCP servers** (from `init --wrap-mcp`): `npx -y zn-gate init --revert` puts back each MCP settings file as it was saved just before zn wrapped it. Changes you made to those files later, such as MCP servers you added, are lost, so add them again afterwards. It only undoes MCP wrapping, not hooks.
2. **Hooks** (Codex CLI, Cursor, OpenCode, Antigravity, ZCode desktop app, GitHub Copilot, Gemini CLI, or Claude Code without the plugin): `npx -y zn-gate hooks uninstall claude-code`. Use `codex`, `cursor`, `opencode`, `antigravity`, `zcode`, `copilot` or `gemini` for the others, and add `--project` if you installed them for one project only. A backup of the settings file is written first.
3. **Claude Code plugin**: run `claude plugin uninstall zn-gate@usezn`, or in Claude Code type `/plugin`, open the **Installed** tab, pick zn-gate and choose **Uninstall**. To also remove the usezn plugin list, run `claude plugin marketplace remove usezn`.
4. **`.env` files you moved into the vault** keep markers such as `__ZN_API_KEY__`. `env shadow` tells you how to put the real values back (`npx -y zn-gate env unshadow .env --backup <name>`). Do that before you delete the vault.
5. **zn's own folder**: zn keeps its vault, settings and counters in a `.zn` folder in your home folder, and removing the plugin, the hooks or the program leaves it there (`zn-gate uninstall` only deletes the launcher scripts in `~/.zn/hooks`). Delete it only after you have put your `.env` values back, because the vault holds them. The second question of `zn-gate uninstall` deletes the vault and what goes with it (its audit log, backups, token maps and session key); the rest of the folder, such as your settings and the decision log, stays. You can also delete the folder by hand.
6. **The program itself**, last, if you installed it with `npm install -g zn-gate`: `npm uninstall -g zn-gate`.
7. **The Python package**, after that, if you installed it with `pip install zn-gate`: `pip uninstall zn-gate`.

Run `npx -y zn-gate check` afterwards if you want to see that zn is off.

## Where to go next

- [What the check means](check.md)
- [Keep your `.env` values in the vault](secrets.md)
- [Every command and exit code](cli.md)
- [Remove zn-gate](uninstall.md)
- [Words you do not know](glossary.md)
- [What zn-gate cannot protect](threat-model.md)
