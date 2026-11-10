# Example: gate a commit message with zn-gate analyze

A git `commit-msg` hook runs `zn-gate analyze` on the message of each commit and stops the commit when zn-gate blocks the text. The repository, the message and every value are made up. Run these steps in your own terminal.

`analyze` checks a piece of text for prompt injection and prints its answer as JSON. Its exit codes are:

| Exit code | Meaning |
|---|---|
| `0` | allowed |
| `1` | no text given |
| `2` | blocked |

The hook below stops the commit for any code other than `0`, so an empty message stops too.

## 1. Install zn-gate

```bash
npm install -g zn-gate
zn-gate version
```

## 2. Save the hook

In the repository, create the file `.git/hooks/commit-msg` with this content. Git runs it with the message file as its first argument:

```sh
#!/bin/sh
# Stop the commit when zn-gate analyze does not allow its message.
msg=$(cat "$1")
zn-gate analyze "$msg" > /dev/null 2>&1
code=$?
if [ "$code" -eq 2 ]; then
  echo "commit stopped: zn-gate analyze blocked the commit message" >&2
  echo "run: zn-gate analyze \"<your message>\" to see the reason" >&2
  exit 1
elif [ "$code" -ne 0 ]; then
  echo "commit stopped: zn-gate analyze exited with $code" >&2
  exit 1
fi
exit 0
```

On macOS and Linux, make it executable with `chmod +x .git/hooks/commit-msg`.

## 3. Try it

A message that describes a normal change goes through as usual:

```bash
git commit -m "Fix the typo in the setup heading"
```

A message that matches one of zn-gate's prompt-injection rules, such as a message that tells an agent to ignore its earlier instructions, is stopped:

```bash
git commit -m "<a message that zn-gate blocks>"
```

```text
commit stopped: zn-gate analyze blocked the commit message
run: zn-gate analyze "<your message>" to see the reason
```

Run the same `zn-gate analyze "<your message>"` command yourself to read the JSON answer. Its `verdict` field is `block` and it has a `reason` field.

## 4. Remove it

```bash
rm .git/hooks/commit-msg
```

## Notes

- The hook only runs on this computer, and git does not copy `.git/hooks` when someone clones the repository. Each person who wants the check installs it.
- `analyze` uses the optional cloud check only when you turned it on. `zn-gate status` shows whether it is on.
- The hook checks text for prompt injection. It is not a secret scanner. For secrets in the files of a commit, see [Run zn-gate scan on each commit](pre-commit-scan.md).

## Related

- [analyze in the command reference](../cli.md#analyze)
- [Scripts and exit codes](scripting.md)
- [Run zn-gate scan on each commit](pre-commit-scan.md)
