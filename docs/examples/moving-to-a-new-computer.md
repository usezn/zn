# Example: setting up zn-gate on a new computer

A short walk-through for moving to a new computer, or setting up a second one. The steps use only fictional values. For the full behaviour, read [first 5 minutes](../first-5-minutes.md), [secrets](../secrets.md) and [files and folders](../files-and-folders.md).

## What moves and what does not

- **Your project files and `.env` files** move the same way as any other file.
- **Your secrets do not move by copying a folder.** The vault lives in `~/.zn` on your old computer, but its key is kept in that computer's keychain (or behind a passphrase). So plan to store each secret again on the new computer. If you cannot re-enter a value, rotate that secret at its provider.
- **The decision log** (`evidence.jsonl` in `~/.zn`) is a record of what zn-gate allowed or blocked on the old computer. It is not needed to protect the new one. Keep the old file if you want the history.
- **The agent hooks** are set up per computer. Install them again on the new one (step 2 below).

## 1. Install zn-gate

On the new computer, in your own terminal:

```sh
npm install -g zn-gate
```

Node.js 18 or later works for the hooks and the command line. The Claude Code plugin needs Node.js 20.19 or later.

## 2. Set up your agents

Run the guided setup. It finds the coding agents on this computer, shows each step, and asks before it runs it:

```sh
zn-gate init
```

Or set up one agent by hand, for example Claude Code:

```sh
zn hooks install claude-code
```

If the project is shared with a team and you want the settings in the project folder, add `--project` to the install command.

## 3. Check that it works

```sh
zn-gate check
```

Every agent you set up should say `OK`. A line that says `NOT protected` names the command that fixes it. Run `zn-gate test` as well to see zn's built-in examples pass on this computer.

## 4. Store your secrets again

Store each value on the new computer, in your own terminal:

```sh
zn secret set NAME
```

To move the values out of a `.env` file again, run `zn env shadow .env`. It shows which values stay in clear text before it changes anything.

## 5. Remove zn-gate from the old computer

When the new computer passes the check, you can remove zn-gate from the old one with `npx -y zn-gate uninstall`. It keeps your vault unless you answer yes to a second question, and it asks before it removes anything. See [Remove zn-gate completely](../faq.md#7-how-do-i-remove-zn-gate-completely).
