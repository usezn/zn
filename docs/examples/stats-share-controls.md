# Examples: stats share controls

How to see, turn on and turn off the optional sharing of daily counts with `zn-gate stats share`. The outputs below were produced by running the commands on a fresh, empty configuration. For every option and exit code, see the [command line reference](../cli.md#stats-share). For the local counts themselves, see [stats and report](stats-and-report.md).

## The default

Sharing is off. Until you turn it on, nothing leaves your machine: the counts that `zn-gate stats` shows stay on it. Only you can turn sharing on, in your own terminal.

## Check whether sharing is on

```bash
zn-gate stats share status
```

```text
Sharing pseudonymous daily counts: off (the default).
```

When it is on, the line reads `Sharing pseudonymous daily counts: on.` The command exits `0` either way. Plain `zn-gate stats share` does the same, and `zn-gate stats` also ends with a line that says whether sharing is on or off.

## See exactly what would be shared

```bash
zn-gate stats share show
```

```text
What is shared, once a day, only if you turn sharing on: a random id for this installation (a new one each time you turn sharing on), the day, the zn-gate version, the operating system, the Node.js major version, the agent and part of zn-gate used most that day, and how many secrets of each built-in type were found (for example AWS_KEY 3). Never secret values, prompts, variable or secret names, file names, paths, repository names, hosts or emails.
Where: <address of zn's telemetry service>

Sharing is off, so nothing is sent. There are no complete days of counts yet to show an example.
```

On your screen the `Where:` line shows the full address of zn's telemetry service (left out above): it is the only place a report is sent, and only after you turn sharing on. What the service keeps is in [API data handling](../api-data-handling.md).

The last line depends on your counts. Once you have at least one complete day of counts, `show` prints a sample report built from them, with the id replaced by a placeholder, so you can read the real fields before you decide. With sharing on, `show` prints the reports that would be sent now, or says nothing is waiting (only complete days are sent). `show` sends nothing and changes nothing.

## Turn sharing on

```bash
zn-gate stats share on
```

It prints the same explanation as `show` and asks `Turn on sharing of these pseudonymous daily counts? [y/N]`. Answer `y` or `yes` to turn it on:

```text
Sharing pseudonymous daily counts is on. Counts from today on are sent when you run `zn-gate stats`.
```

The question can only be answered in an interactive terminal. In a script, a pipe or when an AI agent runs the command, nothing is turned on, and the command exits `1`:

```text
Sharing stays off. (It can only be turned on by you, in your own terminal.)
```

If sharing is already on, the command says so and exits `0`.

## What is sent, and when

- Once sharing is on, `zn-gate stats` sends one report per complete day that has not been sent yet (never today), at most the last 3 days, to the address shown by `show`. The text output then prints `Shared pseudonymous counts for <day>.` for each day sent.
- A report holds a random installation id, the day, the zn-gate version, the operating system, the Node.js major version, the agent and part of zn-gate used most that day, and the number of detections per secret type.
- It never holds secret values, prompts, variable or secret names, file names, paths, repository names, hosts or emails.
- If a day cannot be sent, the output says `<n> day(s) could not be shared; they will be tried next time.`

## Turn sharing off

```bash
zn-gate stats share off
```

```text
Sharing is off. Nothing more is sent; your local counts stay on this machine.
```

Turning it off needs no confirmation. The installation id is removed, so turning sharing on again later starts with a new random id and the new reports are not linked to the old ones. Your local counts stay where they are. The setting is kept in `~/.zn/config.json`.

## An unknown word

Anything other than `on`, `off`, `status` or `show` prints the usage line and exits with code `2`:

```text
Usage: zn-gate stats share on|off|status|show
```

## See also

- [Stats and report examples](stats-and-report.md): the local counts and the weekly report.
- [Command line reference](../cli.md#stats-share): all options and exit codes.
