# Packages your agent installs

A coding agent often installs packages to finish a task. Two things can go wrong. The name can be a copy of a popular package with one letter changed (a "typosquat"), a trick used to spread malware. Or the agent can make up a name that does not exist, and someone can register that name later with bad code in it.

zn-gate can look at the packages an agent installs **by name** and ask you first when one needs a second look. It is **off by default**, it **asks and never blocks**, and in its default form it **does not use the network**.

## At a glance

| Command | Result |
| --- | --- |
| `npm install lodahs` | Asks: `lodahs` looks like the well-known `lodash` (two letters swapped) |
| `pip install requestz` | Asks: `requestz` looks like the well-known `requests` |
| `npm install @babell/core` | Asks: the scope `@babell` looks like `@babel` |
| `npm install lodash` | No question: an exact well-known name |
| `pip install Flask_CORS` | No question: PyPI treats this as the same package as `flask-cors` |
| `npm install my-company-library` | No question: far from every well-known name (offline mode cannot tell if it exists) |
| `npm ci`, `npm install`, `pip install -r requirements.txt` | Not checked: no package name |

## Turn it on

Set `hooks.packageInstallCheck` in `~/.zn/config.json`:

| Setting | What happens |
| --- | --- |
| not set, or `"off"` or `false` | the check is off (the default): your agent's hooks behave exactly as without it |
| `"offline"` or `true` | each name is compared with a list of well-known package names that ships with zn-gate. Nothing is sent anywhere |
| `"online"` | the same, and zn-gate also asks the public registry whether the name exists and when it was first published |

```json
{"hooks": {"packageInstallCheck": "offline"}}
```

The environment variable `ZN_PACKAGE_CHECK=offline` turns on the offline mode for one shell. The environment can only add the offline mode: `ZN_PACKAGE_CHECK=online` is read as `offline`, and `ZN_PACKAGE_CHECK=off` does not turn off what the config file turned on. A project an agent works in can set environment variables, so it must not be able to make zn-gate contact a registry. Only your config file turns the online mode on.

## What is checked

Commands that install packages by name, in Bash or PowerShell, also behind `sudo`, `env`, `cd x &&` and `sh -c "..."`:

| Tool | Commands |
| --- | --- |
| npm, pnpm, Yarn, Bun | `npm install <name>`, `npm i <name>`, `npm add <name>`, `pnpm add`, `yarn add`, `yarn global add`, `bun add`, `bun install <name>` (flags before or after the names, `-g`, `--save-dev`, `@scope/name@^1.2.3`) |
| pip | `pip install <name>`, `pip3 install`, `python -m pip install`, `py -m pip install` (`name==1.2.3`, `name[extra]>=1`) |
| uv | `uv pip install <name>`, `uv add <name>` |
| pipx | `pipx install <name>` |

Not checked in this version:

- **One-off runs** (`npx`, `uvx`, `pipx run`). They run a package without installing it, and they are not read yet.
- **Installs without a name**: `npm ci`, `npm install` alone, `pip install -r file`, `pip install -e .`, local paths, URLs, `git+...` sources and archives (`.tgz`, `.whl`, `.zip`).
- Packages that a script or a project file installs for you (`package.json`, `requirements.txt`).

## What it looks for

**Offline mode** compares a name with a bundled starter list of a few hundred well-known npm and PyPI names. It reports a name only when it is one small step from one of them:

- one letter changed, added or removed, or two neighbouring letters swapped (`lodahs`, `expresss`);
- a character that looks like another: `rn` for `m`, `0` for `o`, `1` or `i` for `l` (`l0dash`);
- the same letters with other separators (`react_dom` for `react-dom`, `socketio` for `socket.io`);
- an npm scope that looks like a well-known scope (`@babell/core`, `@angulr/core`), or a name that looks like a well-known package under a known scope (`@types/reacts`).

It does not report:

- a name that is exactly on the list. PyPI treats upper and lower case and `-`, `_` and `.` as the same, so `Flask_CORS` **is** `flask-cors`, not a copy of it;
- a name that is not on the list and is not close to one: the list is not the registry, so offline mode cannot tell if a name exists;
- names shorter than 5 characters, where one changed letter is too often another real package.

**Online mode** also looks at names the offline step did not report and the list does not know:

- the registry says the name does **not exist**: the name may have been made up by the agent;
- the package was **first published less than 14 days ago**: a very new package. Change the limit with `hooks.packageInstallNewDays` (1 to 365).

## What you see

Your agent asks you to approve or refuse the install. The question names the package and, for a look-alike, the name it may have been meant to be. For example:

> zn: this command installs a package that needs a second look: npm package `lodahs` looks like the well-known `lodash` (did you mean `lodash`?). Names that copy popular packages are used to spread malware, and an agent can make up a name that does not exist. Approve it only if this is the package you want. To stop this question for a name, add it to hooks.packageInstallAllow in ~/.zn/config.json.

This never blocks a command by itself. Agents that cannot show a question (Codex CLI, OpenCode and Gemini CLI) run the command; the finding is still written to the decision log (see below). Where nobody is there to answer, for example Claude Code with `claude -p`, the agent treats a question as a refusal, as it does for every other question from zn-gate.

## Allow a name

List names that should never be questioned in `hooks.packageInstallAllow`. An entry is a package name (`my-tool`), and `@scope/*` covers a whole npm scope. PyPI names are compared after PyPI's own normalisation.

```json
{"hooks": {"packageInstallAllow": ["my-tool", "@my-company/*"]}}
```

## What leaves your computer

**Offline mode and the default: nothing.** It reads the command text and a file that ships with zn-gate.

**Online mode: only the package name**, in one plain request to the public registry the package would come from anyway:

- `https://registry.npmjs.org/<name>` for npm (a scoped name is sent as `@scope%2Fname`);
- `https://pypi.org/pypi/<name>/json` for PyPI.

The request has no cookies, no account and no header except `Accept`. It carries no command, path, project name or other data. The name is checked against the characters a registry allows before it is put in the URL. A redirect is not followed, a reply over 4 MiB is dropped, and a lookup that takes more than 2 seconds is given up. Names on the bundled list, names that look like a well-known one, names you allowed, and npm names with capital letters are not looked up.

If you use another registry, zn-gate does not send your names to the public one. It does not look up a name when the command has `--registry`, `--index-url` or `--extra-index-url`, or when an `.npmrc` (in the project folder or your home folder), `pip.conf`, `uv.toml`, `pyproject.toml` index setting or an environment variable such as `NPM_CONFIG_REGISTRY` or `PIP_INDEX_URL` names a registry other than the public one. If your private setup is somewhere zn-gate does not read, do not use online mode.

Answers are kept for one day in `~/.zn/package-registry-cache.json` (only the name, whether it exists and the date of its first release; the file is private to you). If it cannot be read or written, the check goes on without it. If a lookup fails for any reason (no network, a timeout, an error from the registry, an answer zn-gate does not understand), **no question is asked**, and a note goes to the decision log.

If your computer reaches the internet through a proxy that Node.js does not use by default, online lookups fail and the check goes on without them.

## Decision log

Each question, and each online lookup that gave no answer, is written to the [decision log](architecture.md) (`~/.zn/evidence.jsonl`) as an `allow` record with one of these rules: `hook-package-check-look-alike`, `hook-package-check-not-found`, `hook-package-check-new`, `hook-package-check-unavailable`. The record names the package and never holds the command.

## Limits

- It reads the **name**, not the package. A malicious package with a legitimate-looking name, or a real package that was taken over, is not caught.
- The bundled list is a **starter list** written by hand. It ages, it is not complete, and it can miss a popular package or flag a legitimate name that is one letter from a popular one. Add such a name to `hooks.packageInstallAllow`.
- Offline mode cannot know whether a name exists. Online mode can, but only for names it is allowed to look up (see above).
- It is a guardrail, not a sandbox: it reads the text of a command. An install that a script performs, or a name the shell builds at run time (`npm i $PKG`), is not seen.
- The Python package (`zn-gate` on PyPI) does not install hooks, so this check is part of the Node.js hooks only.

## Cost

With the check off, nothing is loaded. In offline mode a command that is not an install costs one match against its text, and an install costs well under a millisecond (measured at about 30 microseconds for two names that are not on the list). Online mode can add up to 2 seconds to a command that needs a lookup, once per name and day.
