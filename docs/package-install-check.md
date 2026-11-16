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

The environment variable `ZN_PACKAGE_CHECK=offline` turns on the offline mode for one shell. The environment can only add the offline mode: `ZN_PACKAGE_CHECK=online` is read as `offline`, and `ZN_PACKAGE_CHECK=off` does not turn off what the config file turned on. A project an agent works in can set environment variables, so it must not be able to make zn-gate contact a registry. Only your config file turns the online mode on (this assumes a project an agent works in does not set `ZN_HOME`, the variable that moves zn-gate's config folder).

## What is checked

Commands that install packages by name, in Bash or PowerShell, also behind `sudo`, `env`, `cd x &&` and `sh -c "..."`:

| Tool | Commands |
| --- | --- |
| npm, pnpm, Yarn, Bun | `npm install <name>`, `npm i <name>`, `npm add <name>`, `pnpm add`, `yarn add`, `yarn global add`, `bun add`, `bun install <name>` (flags before or after the names, `-g`, `--save-dev`, `@scope/name@^1.2.3`) |
| pip | `pip install <name>`, `pip3 install`, `python -m pip install`, `py -m pip install` (`name==1.2.3`, `name[extra]>=1`) |
| uv | `uv pip install <name>`, `uv add <name>` |
| pipx | `pipx install <name>` |

The offline check reads the forms in this table, also behind `sudo`, `env`, `cd x &&` and `sh -c "..."`. The online lookup reads only the plain installs described in [What leaves your computer](#what-leaves-your-computer).

Not checked in this version:

- **One-off runs** (`npx`, `uvx`, `pipx run`). They run a package without installing it, and they are not read yet.
- **Installs without a name**: `npm ci`, `npm install` alone, `pip install -r file`, `pip install -e .`, local paths, URLs, `git+...` sources and archives (`.tgz`, `.whl`, `.zip`).
- Packages that a script or a project file installs for you (`package.json`, `requirements.txt`).
- **npm aliases** (`npm i name@npm:other`) and **`yarn workspace <workspace> add <name>`**. They are skipped.

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

**Online mode: only the package name, and only for a plain install**, in one plain request to the public registry the package would come from anyway:

- `https://registry.npmjs.org/<name>` for npm (a scoped name is sent as `@scope%2Fname`);
- `https://pypi.org/pypi/<name>/json` for PyPI.

The request has no cookies, no account and no header except `Accept`. It carries no command, path, project name or other data. The name is checked against the characters a registry allows before it is put in the URL. A redirect is not followed, a reply over 4 MiB is dropped, and a lookup that takes more than 2 seconds is given up. At most 8 names of one command are looked up for the question; the others are noted in the decision log as having had no lookup ("too many names"). Names you allowed, npm names with capital letters and names that look like a well-known one are never looked up. A name on the bundled list is not asked about for the question, but it can be looked up for the version notice (see Notices).

**Which commands are looked up: only plain installs.** The online lookup uses an allow list, not a list of registries to avoid. The whole command line must be a plain install, or none of its names is looked up:

- every simple command in the line is an install of one of these forms: `npm|pnpm|bun install|i|add`, `yarn add` or `yarn global add`, `pip|pip3|pipx install`, `python|python3|py -m pip install`, `uv add` or `uv pip install`;
- joined only by `&&` or `;` (no pipe, redirect, background `&`, line break, subshell, `{ }` group, `$`, backtick, `\`, `#`, `!`, `*` or `?`);
- no wrapper and no variable in front: no `sudo`, `env`, `sh -c`, `cd`, `VAR=value`, `export`;
- every word is a package name (`name`, `name@1.2.3` or `name@^1.2` for npm, `name`, `name[extra]` or `name==1.2.3` for PyPI, optionally quoted), or one of the switches below. A name that is a path, a URL, a git source, an alias, or a glob is not a name;
- the switches are a closed list that changes neither the registry, the index, a settings file nor a value: `-D`, `--save-dev`, `-O`, `--save-optional`, `-P`, `--save-prod`, `-S`, `--save`, `--no-save`, `-E`, `--save-exact`, `-g`, `--global`, `--no-audit`, `--no-fund`, `--legacy-peer-deps`, `--ignore-scripts`, `-q`, `--quiet`, `--silent`, `-U`, `--upgrade`, `--user`, `--no-deps`, `--pre`, `--no-cache-dir`, `--disable-pip-version-check`, `--break-system-packages`, `--no-input`, `--ignore-installed`, `--dev`, `--no-sync`, `--frozen`.

Any other word makes the whole line **not plain**: a flag that is not in the list (`--registry`, `--reg`, `--regis`, `--index-url`, `-i`, `-f`, `--ind`, `--extra-i`, `--find`, `--pip-args`, `--prefix`, `-r`, `--userconfig`, `--foo`), a joined or abbreviated flag (`-qi URL`, `-i<URL>`), a value, a file, a variable, or any form zn-gate does not read. A name in a line that is not plain is still checked offline (it can still be reported as a look-alike), but it is **never** sent to the public registry. So `npm i left-pad --registry https://npm.example.com`, `pip install -i https://pypi.example.com/simple corp-tool`, `cat .npmrc && npm i left-pad`, `export PIP_INDEX_URL=... && pip install x` and `npx x` look up nothing. `npm ci`, `npm install` and `pip install -r requirements.txt` have no name to look up.

The check does not try to recognise every registry setting; it lets through only the commands it understands. Settings that the environment or a settings file in your project or your home folder can set are read as described below, only in online mode:

- npm, pnpm, Yarn, Bun: `.npmrc`, `.yarnrc`, `.yarnrc.yml` and `bunfig.toml` (also `.bunfig.toml`) in the folder the agent works in and in your home folder; the file named by `NPM_CONFIG_USERCONFIG`.
- pip and uv: `~/.config/pip/pip.conf`, `~/.pip/pip.conf`, `~/pip/pip.ini`, `~/Library/Application Support/pip/pip.conf`, `~/AppData/Roaming/pip/pip.ini`, `%APPDATA%\pip\pip.ini`, `$XDG_CONFIG_HOME/pip/pip.conf`, `$XDG_CONFIG_HOME/uv/uv.toml`, `~/.config/uv/uv.toml`, `$VIRTUAL_ENV/pip.conf`, `/etc/pip.conf`, `uv.toml`, `pip.conf` and `pyproject.toml` in the working folder, and the files named by `PIP_CONFIG_FILE` and `UV_CONFIG_FILE`.
- The process environment variables listed above.

It does **not** read the npm global config (`$PREFIX/etc/npmrc`), an `.npmrc` in a parent of the working folder, or other settings files. If your private setup is somewhere zn-gate does not read, do not use online mode.

Answers are kept in `~/.zn/package-registry-cache.json`, one per name, for one day (for one hour when the answer is about the latest release). An answer holds only the name, whether it exists, the date of its first release and, when the command names a version, that version and its publish date; the file is private to you. If it cannot be read or written, the check goes on without it. If a lookup fails for any reason (no network, a timeout, an error from the registry, an answer zn-gate does not understand), **no question is asked**, and a note goes to the decision log.

If your computer reaches the internet through a proxy that Node.js does not use by default, online lookups fail and the check goes on without them.

## Notices (opt-in)

Two notes that never ask and never block. They are off by default, and they only run when the check itself is on (`offline` or `online`). Turn them on in `~/.zn/config.json`:

```json
{"hooks": {"packageInstallCheck": "online", "packageInstallNotices": ["fresh_version", "no_lockfile"]}}
```

`true` turns on both. The command still runs, and the note does not change what the agent is allowed to do. Your agent's hook shows the note to you where the agent supports it.

- `fresh_version` (online mode only): the version the command installs was **published less than 72 hours ago**. A pinned version (`pkg@1.2.3`, `pkg==1.2.3`) or the latest release (no version in the command) is judged. A range or a tag (`pkg@^1`, `pkg@next`) is not, because the version that will be installed is not known. Only a **plain install** is judged (see "What leaves your computer"). A command that is not a plain install gets no such note, even when it installs a name: no registry is asked about it, neither for the question nor for the note. This is on purpose: the note is only as safe as the lookup behind it, and the lookup is allowed only for plain installs.
- `no_lockfile` (offline or online): the command runs `npm install` or `npm i` in a project. npm uses the lockfile in that case, but it does not require it and may update it. `npm ci` installs exactly what the lockfile records. The note suggests `--ignore-scripts`, unless the command already has it. Global installs (`-g`, `--global`, `--location=global`) are not noted. This note is read from the text of the command, in any mode and for any command the check can read. It makes no request anywhere, and it sends nothing about a name, so it is not limited to plain installs: the plain rule decides what may leave the computer, and a reading of the command does not send anything.

### Registry requests of the version notice

The version notice adds a registry request in one case only: a name **on the bundled list** (such as `react`, `lodash` or `express`) that a plain install names with a pinned version or with no version. The existence question never asks about those names, so that is the only extra request. For a name that is not on the bundled list, the existence question already makes the request, and the notice reads the version from that same reply: no second request is made.

The request is the same as the one above, `https://registry.npmjs.org/<name>` or `https://pypi.org/pypi/<name>/json`, with no version in the URL. The notice has a budget of its own: at most 8 names per command, and the question's budget is not reduced by it. The notice lookups run after the question lookups, so a command can take up to 2 seconds more in the worst case. Look-alike names, names you allowed, npm names with capital letters, and ranges and tags are never asked about for the notice.

Answers are kept in the cache file for one day for a pinned version, and for one hour for the latest release. The cache keeps one answer per name, so a command that asks for another version of a name asks the registry again, even within the day.

### Registry replies over 4 MiB

zn-gate drops a registry reply larger than 4 MiB and gives no answer for that name. An npm reply is the full record of a package, and for some popular packages it is much larger than that. So **the version notice is never shown for such a name**, whatever version is installed. The same limit applies to PyPI replies. The size of a PyPI reply is not known in advance, so a notice can be missing for a large project. A name that is not on the bundled list and whose reply is too large is reported as unavailable, as any lookup without an answer.

## Decision log

Each question, and each online lookup that gave no answer, is written to the [decision log](architecture.md) (`~/.zn/evidence.jsonl`) as an `allow` record with one of these rules: `hook-package-check-look-alike`, `hook-package-check-not-found`, `hook-package-check-new`, `hook-package-check-unavailable`. The record names the package and never holds the command.

## Limits

- It reads the **name**, not the package. A malicious package with a legitimate-looking name, or a real package that was taken over, is not caught.
- The bundled list is a **starter list** written by hand. It ages, it is not complete, and it can miss a popular package or flag a legitimate name that is one letter from a popular one. Add such a name to `hooks.packageInstallAllow`.
- Offline mode cannot know whether a name exists. Online mode can, but only for names it is allowed to look up (see above).
- **A registry that the check cannot see.** It reads the text of the command and the settings files listed above, nothing more. It does not see a registry set by a script the command starts (a `package.json` script, a Makefile), or by an `.npmrc` or `pip.conf` in a folder other than the working folder and your home folder (it reads the settings of those two folders, listed above). A command that sources a file, runs `eval` or changes folder is not a plain install, so it is never looked up. In the other cases a private package name may still be sent to the public registry in online mode. If you use a private registry, do not use online mode, or set the registry in the user-level settings that zn-gate reads (your home folder's `.npmrc`, `~/.config/pip/pip.conf`, `~/.config/uv/uv.toml`, or the environment variables listed above).
- It is a guardrail, not a sandbox: it reads the text of a command. An install that a script performs, or a name the shell builds at run time (`npm i $PKG`), is not seen.
- The online lookup uses the system and Node.js trust store, including `NODE_EXTRA_CA_CERTS`, so a project could add a certificate authority through its environment; the effect is limited to silencing a question, because the check never blocks.
- The Python package (`zn-gate` on PyPI) does not install hooks, so this check is part of the Node.js hooks only.

## Cost

With the check off, nothing is loaded. In offline mode a command that is not an install costs one match against its text, and an install costs well under a millisecond (measured at about 30 microseconds for two names that are not on the list). Online mode can add up to 2 seconds to a command that needs a lookup, once per name and day.
