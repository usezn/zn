# Examples: look at what stats sharing would send, before you turn it on

A worked example of the order to follow with `zn-gate stats share`: first see your local counts, then read what would be sent and where, and only then decide to turn sharing on or leave it off. All values below are made up. The outputs come from real runs of zn-gate in a throwaway home folder, with the test events listed at the start; the numbers on your computer will differ. For every option and exit code, see the [command line reference](../cli.md#stats).

Back to the [examples index](README.md).

Sharing is off by default. Every command in steps 1 to 3 only reads files on your computer: none of them opens a connection.

## The test events

The test folder had a `.env` file with a made-up value. Four events went through the Claude Code hook: a prompt with a made-up AWS key, the command `cat .env`, a read of the same file by its full path, and a command output with a made-up GitHub token. No real secret was used.

## 1. See your local counts

```bash
zn-gate stats
```

```text
zn-gate on this machine, last 30 days (counting since 2026-11-11):

  4 events checked (prompts, tool calls and tool results)
  3 blocked (a secret file read, a pasted secret, a prompt injection or a risky call)
  1 secret values replaced before the model saw them

  Secret types found: AWS_KEY 1, GITHUB_TOKEN 1

  Top rules, last 7 days:
    AWS_KEY  Built-in detector  1
    GITHUB_TOKEN  Built-in detector  1
  Most frequent: AWS_KEY. To understand your last block, run: zn why

  By agent:
    claude-code (agent hooks): 4 events, 3 blocked, 1 replaced

  These counts stay on this machine. To help improve zn-gate, you can share pseudonymous daily counts:
  `zn-gate stats share show` shows exactly what would be sent, `zn-gate stats share on` turns it on.
```

The last two lines say that nothing leaves your computer, and point to the next step.

## 2. Check the state

```bash
zn-gate stats share status
```

```text
Sharing pseudonymous daily counts: off (the default).
```

## 3. Show what would be sent

```bash
zn-gate stats share show
```

The first lines say what a report holds and where it would go:

```text
What is shared, once a day, only if you turn sharing on: a random id for this installation (a new one each time you turn sharing on), the day, the zn-gate version, the operating system, the Node.js version, the agent and part of zn-gate used most that day, and how many secrets of each built-in type were found (for example AWS_KEY 3). Never secret values, prompts, variable or secret names, file names, paths, repository names, hosts or emails.
Where: https://api.usezn.com/v1/telemetry.
```

When sharing is off, the command only shows an example. It is built from your counts of the last complete day, with a placeholder instead of the random id. Right after your first use there is no complete day yet, because only days before today are shared:

```text
Sharing is off, so nothing is sent. There are no complete days of counts yet to show an example.
```

The next day, with the same counts moved to the day before, it ends like this:

```text
Sharing is off, so nothing is sent. With sharing on, a report built from your counts would look like this:
{"install_id":"<random id>","day":"2026-11-10","zn_gate_version":"1.15.0","os":"linux","node_major":24,"agent":"claude-code","layer":"hook","detections":{"AWS_KEY":1,"GITHUB_TOKEN":1}}
```

## 4. Read it

| Field | What it holds |
| --- | --- |
| `install_id` | A random id for this installation. Turning sharing off and on again makes a new one, so old reports cannot be linked to the new id. |
| `day` | One complete day. |
| `zn_gate_version`, `os`, `node_major` | The version of zn-gate, the operating system and the major version of Node.js. |
| `agent`, `layer` | The agent and the part of zn-gate with the most checks that day. A name that zn-gate does not know is sent as `other`. |
| `detections` | How many secrets of each built-in type were found. Only the type and a count. |

There is no value, no prompt, no file name, no path and no host in it. The address is fixed in zn-gate: `ZN_API_URL` does not change where `stats share` sends.

## 5. Turn it on, or leave it off

Turning sharing on is something only you can do, in your own terminal. It asks first. If you answer `n`, nothing changes and the command exits with code `1`:

```bash
zn-gate stats share on
```

```text
Turn on sharing of these pseudonymous daily counts? [y/N] n
Sharing stays off. (It can only be turned on by you, in your own terminal.)
```

The command also prints the "What is shared" and "Where" lines from step 3 before it asks. With `y`:

```text
Sharing pseudonymous daily counts is on. Counts from today on are sent when you run `zn-gate stats`.
```

Two things to know once it is on:

- Only days from the day you turned it on are sent. The example in step 3 can show an earlier day, but that day is not sent.
- `zn-gate stats` is what sends: it sends each complete day that was not sent yet, at most the last 3 days. `stats share show` still sends nothing. With sharing on, it lists what would be sent now, or says `Nothing to send right now (only complete days are sent).`

To turn it off again:

```bash
zn-gate stats share off
```

```text
Sharing is off. Nothing more is sent; your local counts stay on this machine.
```

Your local counts stay where they are. An option or word that `stats share` does not know prints the usage line and exits with code `2`.

## See also

- [Examples: stats and report](stats-and-report.md): more outputs of `stats` and `report`.
- [`stats share show` in the command line reference](../cli.md#stats-share-show)
- [What leaves your machine](../../README.md#what-leaves-your-machine)
