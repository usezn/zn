# Example: MCP tool pins in a shared repository

A question that comes up in a team: the shield pins MCP tools, so should the pin files be committed to the repository, or ignored? This page answers it from what zn-gate really does: where the pins are kept, what is in them, and what that means for a repository that several people use. For the full reference, read [Tool pinning](../shield.md#tool-pinning) and [`pins` in the command reference](../cli.md#pins).

The output below comes from real runs with a fake MCP server and a throwaway home folder, which is shown as `~`. The shield also printed a line saying that its pins were kept in a folder other than your own `~/.zn`, because the run used a throwaway `HOME`. You will not see that line in normal use, and it is left out here. The owner of the file is shown as `you`.

## Where the pins are

Pins are kept for each user, not for each repository. The shield writes one small file for each pinned server in `~/.zn/mcp-pins/`, or in the `mcp-pins` folder under the folder that `ZN_HOME` names when you set it. The file is readable only by your account.

To check, a repository with a fake MCP server (`server.js`, two tools) was created, committed, and wrapped with the shield. The shield was fed the two requests that an agent sends first, to start and to list the tools. It printed one line:

```text
[zn-shield] Pinned the tools of a new MCP server (dee5a8d31728567b): node ~/team/app-a/server.js
```

Then the pins and the repository:

```bash
ls -l ~/.zn/mcp-pins
zn-gate pins
git status --short
```

```text
-rw------- 1 you you 638 Nov 11 15:21 dee5a8d31728567b.json
MCP tool pins (~/.zn/mcp-pins, mode: warn)

  dee5a8d31728567b  node ~/team/app-a/server.js
      2 tool(s) pinned 2026-11-11T15:21:46.931Z
```

`git status --short` printed nothing. The repository had no new file: the pin was written in the home folder, and no folder of the project got a `.zn` folder.

## What is in a pin file

Each file holds the program and its arguments (with secrets removed), the names of the tools, and fingerprints of their definitions: the keys of the file are `command`, `pinnedAt`, `firstPinnedAt`, `tools`, `pending` and `parts`. It never holds tool text. The `command` is the command line as it ran on your machine, so it carries the path of your checkout.

## Why teammates cannot share pins

The name of a pin file, the server key, is computed from the program and its arguments. An argument that names a file is turned into its full path first. That is why the same `server.js` in two folders is two different servers. In the run, a copy of the same `server.js` in a second folder got another key, and the shield also warned about it:

```text
[zn-shield] Pinned the tools of a new MCP server (b5f2544da4e1be81): node ~/team/app-b/server.js
[zn-shield TOOL SHADOWING] take_notes, list_notes: have the same name as an approved tool of another MCP server. The agent may call the wrong one. Check that both servers are yours.
```

The warning appears because both servers offer tools with the same names. Teammates whose checkouts are in different folders get different keys, so a pin file copied from one machine would not match on another.

## What follows for a shared repository

From the above:

- There is no pin file in the repository, so there is nothing to commit and nothing to add to `.gitignore`.
- Do not copy `~/.zn/mcp-pins/` into a repository. The files belong to one user and one command line, and they hold the path of your checkout.
- Each person pins on their own machine: the first time the shield sees the tool list of a server, it trusts it, and later changes are flagged for that person. Each person reviews and approves a change in their own terminal with `zn-gate pins approve`, which refuses to run under an AI agent.
- What a repository can hold is the MCP settings of the project, with the shield in front of a server. That is a settings file, not a pin file.

## Related

- [Protect MCP servers: shield, shadow mode and tool pins](../shield.md)
- [First run of the shield](shield-first-run.md)
- [What to compare before you approve a changed tool](mcp-pin-review-checklist.md)
- [`pins` in the command reference](../cli.md#pins)
