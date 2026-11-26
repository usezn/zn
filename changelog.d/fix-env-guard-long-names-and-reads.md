### Security
- A file name longer than 4096 characters, or a percent-encoded `file:` address, that names a project `.env` is now refused in
  an MCP call and in a tool zn does not know, in every agent, and in the file tools of Gemini CLI. Before, such a name was left
  out of the check, so the call went ahead (for example a path padded with `./` before `.env`). A long name of another
  protected file in a Gemini CLI file tool is refused the same way.

### Fixed
- Commands that load a project `.env` without running it pass again: the `--env-file` option of node, bun, deno, docker and
  podman, and `-e` / `-f` of the dotenv, dotenv-cli and dotenvx runners. A command that zn cannot prove read-only is still
  refused, and the message now says that zn cannot tell whether it writes the file and how to load it instead.

### Changed
- These stay refused when they name a project `.env`: `source .env` and `. .env` (they run the file as shell code, which can
  rewrite the file itself; use `--env-file` or `dotenv -e`), and `python3 -m venv .env` (give the virtual environment another
  name).
