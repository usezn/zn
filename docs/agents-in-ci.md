# Coding agents in CI: keep an issue or a pull request from exposing your secrets

A coding agent that runs in a GitHub Actions workflow reads text and then acts: it can run commands, edit files and call APIs with the token and secrets the job holds. If anyone can write some of that text, anyone can try to give the agent orders. This page explains where that happens, how to lay out a workflow so a successful attempt gets nothing valuable, what `zn audit` rule ZNA019 reports, and what zn-gate does not do in CI.

It is a guide for people who already run an agent in a workflow, or plan to. The [GitHub Action page](github-action.md) covers the zn-gate Action itself (inputs, outputs, SARIF) and is not repeated here.

## Why text from outside the team is a risk

A model cannot reliably tell the task it was given from instructions hidden in the text it is working on. That is prompt injection. In CI the stakes are higher than on a laptop, because the job often runs with a repository token that can write and with secrets that were stored for deployment.

Text that anyone can write, or that the author of a pull request controls:

- the body and title of an issue, and its comments;
- the title and description of a pull request, and its review comments;
- the name of a branch;
- the files of a pull request from a fork, including the agent's own configuration (`CLAUDE.md`, `AGENTS.md`, `.mcp.json`, hooks), which [`zn audit`](audit.md) reads;
- the output of a tool the agent calls, such as a web page or an issue it fetches.

The route to a secret is short: untrusted text reaches the agent, the agent holds a token or a secret, and a command or a request sends it out. Each rule below cuts one link of that chain.

## Rules for a hardened workflow

Each rule says what GitHub does, so you can check it against GitHub's own documentation (names are given at the end of the list).

1. **Choose the trigger with care.**
   - `pull_request` runs the workflow for the pull request. For a pull request from a fork, GitHub gives it a read-only `GITHUB_TOKEN` and does not pass your secrets to it. This is the safe trigger for anything that reads the code of a pull request.
   - `pull_request_target` runs the workflow file from the base branch, with your secrets and a token that can have write permissions, even for a pull request from a fork. If the workflow checks out and runs the pull request's code, or runs an agent on it, the author of that code gets those privileges. Do not do either in a `pull_request_target` workflow.
   - `issues` and `issue_comment` also run with your secrets and token, and anyone who can open an issue or comment can start them. Run an agent on them only for authors you trust (rule 6).
2. **Give the token the least it needs.** Set `permissions: {}` at the top of the workflow and add the scopes each job needs. When a workflow sets `permissions`, every scope it does not name is `none`. Do not rely on the repository default, which depends on a setting of the repository or organization.
3. **Keep secrets out of the job that reads untrusted text.** Put the secret in a separate job that does not read the issue or pull request text, and that starts only after a check or an approval.
4. **Use an environment for secrets.** A secret stored in an environment is available only to jobs that name that environment, and the environment can require a reviewer to approve each run before the job starts. Some protection rules depend on your plan and on whether the repository is public; see GitHub's documentation.
5. **Never put untrusted text in a script.** A `${{ ... }}` expression is replaced by its value before the shell runs, so a title like `"; curl ... #` becomes part of the command. Pass the value through `env:` and read it as a shell variable if a script really needs it. That protects the shell, not the agent: text you hand to an agent is still text the agent obeys, so give the agent a fixed prompt and the checked-out files rather than the issue or pull request text.
6. **Filter by author.** For `issue_comment` and similar triggers, add an `if:` on the author's relationship to the repository, for example `contains(fromJSON('["OWNER","MEMBER"]'), github.event.comment.author_association)`.
7. **Pin actions by full commit SHA.** A tag or a branch can be moved to different code; a commit SHA cannot. Keep the version in a comment (`# v7.0.1`) so tools such as Dependabot can update the pin.
8. **Do not keep credentials in the checkout.** `actions/checkout` stores the token in the repository's git configuration by default, where any later step, including an agent, can read it. Set `persist-credentials: false`.
9. **Limit what a run can do and cost.** Set `timeout-minutes` and a `concurrency` group, so a loop or a flood of comments does not run for hours.
10. **Do not give the agent write access it does not need.** An agent that only reviews needs `contents: read` and, to comment, `pull-requests: write`. Give `contents: write` only to a job that must push, and only there.

GitHub's documentation covers all of this: see "Security hardening for GitHub Actions", "Events that trigger workflows", "Automatic token authentication" (for `GITHUB_TOKEN` permissions) and "Managing environments for deployment".

## What ZNA019 flags

[`zn audit`](audit.md) rule ZNA019 reads the workflow files in `.github/workflows/` (only that exact path; GitHub runs no other) and reports a workflow that runs an AI agent on input from outside the team. It runs nothing from the repository.

It reports a workflow when both of these are true:

- **An agent runs.** A step uses one of these actions: `anthropics/claude-code-action` (and `claude-code-base-action`), `google-github-actions/run-gemini-cli`, `openai/codex-action`, an OpenCode action (`sst/opencode` or `anomalyco/opencode`), an Amazon Q action, or a GitHub Copilot action; or a `run:` step contains one of these commands: `claude -p` (or `--print`), `codex exec`, `gemini -p` (or `--prompt`), `opencode run`, `q chat --no-interactive`.
- **An untrusted trigger starts it.** The `on:` section lists `issues`, `issue_comment`, `pull_request_target`, `pull_request_review_comment`, `pull_request_review`, `discussion` or `discussion_comment`.

The severity is **high** when any of these holds, and **medium** otherwise:

| What the rule sees | Severity |
|---|---|
| The trigger is `pull_request_target` | High |
| An issue, comment, pull request, review or discussion `body` or `title` is written into the workflow with `${{ github.event... }}`, including through `env:` | High |
| The action is opened to users without write access (`allowed_non_write_users`, or `allow_users: "*"`) | High |
| A `run:` step starts the agent CLI, the workflow has write permissions, and there is no author filter | High |
| None of the above (for example a common agent action, which checks the actor's own permission before it runs) | Medium |

An author filter is recognised when the file mentions `author_association`, or compares `github.actor` or the comment, issue or sender login with `==`.

Here is the finding for a workflow that runs an agent on `issue_comment`, with write permissions and the comment text as the prompt (the file name and line number depend on your workflow: the line is the one of the agent step):

```text
HIGH      ZNA019  .github/workflows/agent.yml:12  [claude]
          CI workflow runs an AI agent on input anyone can write
          An AI agent (claude) runs on input from outside the team: triggered by issue_comment; issue or comment text is pasted into the workflow; the workflow has write permissions.
          evidence: - uses: anthropics/claude-code-action@v1
          fix: Restrict the trigger to trusted authors (author_association), avoid pull_request_target, and give the job read-only permissions.
```

### Fix a finding

1. Remove the issue or comment text from the workflow: no `${{ github.event.comment.body }}` in a prompt, an `env:` value or a script. Give the agent a fixed prompt.
2. Replace `pull_request_target` with `pull_request` unless the job only labels or comments and checks out none of the pull request's code.
3. Add the author filter (rule 6) so the agent starts only for people you trust.
4. Set `permissions: {}` at the top and `contents: read` on the job, and add scopes only where needed.
5. Do not use `allowed_non_write_users` or `allow_users: "*"`.

After these changes the same workflow is reported as **medium**, not removed (the line moves with your edits):

```text
MEDIUM    ZNA019  .github/workflows/agent.yml:13  [claude]
          CI workflow runs an AI agent on input anyone can write
          An AI agent (claude) runs on input from outside the team: triggered by issue_comment; an author filter is present.
```

ZNA019 cannot tell a workflow that is safe from one that is merely filtered, so it keeps reporting the trigger. Medium does not fail the Action with its default `severity-threshold` of `high`. Read the finding, check the rules above by hand, and keep the filter and the permissions in place. If you do not need the agent to run on outside input, run it on `pull_request` from your own branches instead, as the example below does: ZNA019 does not report that trigger.

## Example workflow

[`examples/github-action/agent-in-ci.yml`](../examples/github-action/agent-in-ci.yml) puts the rules together for an agent that works on pull requests:

- It uses `pull_request`, so a pull request from a fork gets no secrets (rule 1).
- `permissions: {}` at the top, then only the scopes each job needs (rules 2 and 10).
- The first job runs the zn-gate Action in `mode: both` with SARIF output and uploads the result to code scanning. It reads the pull request's files and holds no secret (rule 3).
- The second job is the only one with a secret. It starts after the first one, only for branches of the same repository, and uses an environment (`coding-agent`) that you set up with required reviewers and the secret `AGENT_API_KEY` (rules 3 and 4). The agent job runs `./ci/run-agent.sh` from the pull request's own checkout, so anyone who can push a branch to the repository can change that script: the required reviewer of the `coding-agent` environment is the only barrier, and the reviewer must read the whole diff, scripts included, before approving. Keep `AGENT_API_KEY` only as a secret of that environment, not also as a repository secret: a repository-level copy would reach the job without the approval.
- The agent gets no pull request text: no title, description or branch name appears in the workflow (rule 5).
- Every action is pinned by commit SHA, checkout keeps no credentials, and each job has a timeout and a concurrency group (rules 7, 8 and 9).

The step that starts the agent calls a script, `./ci/run-agent.sh`, that you write: replace it with your agent's own action or command. Create the `coding-agent` environment in the repository settings before the first run.

The Action line pins a release by commit SHA, as on the [GitHub Action page](github-action.md#minimal-workflow). Take the SHA of the release you want from the [releases page](https://github.com/usezn/zn/releases). When you move to a newer release, set `version` to the same release. `zn audit` reports nothing for this workflow: its only trigger is `pull_request`.

## Where the zn-gate Action and `zn run` fit

**The Action** installs the published zn-gate packages on the runner and runs `zn audit` and `zn-gate scan` there. The audit runs nothing from your repository. Use these inputs, defined in `action.yml` and described on the [GitHub Action page](github-action.md#inputs):

| Input | What it does here |
|---|---|
| `mode` | `audit` reads agent configuration and workflows (ZNA019 included), `scan` looks for prompt-injection traps and leaked secrets in files, `both` runs the two |
| `format` | `sarif` writes a file you upload to code scanning; `github` shows annotations on the pull request |
| `severity-threshold` | Lowest audit severity that fails the step (default `high`; the example sets `medium`) |
| `fail-on` | When set, overrides `fail-on-threat` and `severity-threshold`; `none` never fails |
| `version` | Exact zn-gate version to install; set it to the release you pinned |

Its output `sarif-file` is the path to pass to `github/codeql-action/upload-sarif`. Give the job `contents: read`, plus `security-events: write` for the upload, as in the example. On a pull request from a fork GitHub may not allow the upload; the audit still runs and still sets the status of the job.

**`zn run`** gives a program a secret from the zn vault, and the first time a secret is used with a program, a person must confirm it in a dialog or in the terminal where the vault runs. A runner has neither, and zn refuses a request when it has no way to ask ([threat model](threat-model.md#confirmation-channel)). So `zn run` is a tool for a developer's machine, where an agent should use a secret without seeing it ([keep secrets out of your agent](secrets.md#4-let-a-command-use-a-secret)). It is not a way to hand secrets to a job in CI. In CI, use GitHub's secrets and environments, as in rules 3 and 4.

## What zn-gate does not protect in CI

- **It does not run inside your agent's job.** The Action audits and scans the repository, then exits. It does not install zn-gate's hooks or vault for the agent that your workflow starts, does not filter what that agent reads or runs, and does not sandbox it or limit its network.
- **ZNA019 covers a fixed list of agents and triggers.** An agent started through a script or an action not listed above is not recognised, and a workflow with no recognised agent gets no ZNA019 finding, whatever its triggers. ZNA019 reads the file as text and takes the triggers from the part before `jobs:`.
- **It does not check the rest of your workflows.** It does not report unpinned actions, a missing `persist-credentials: false`, a missing `permissions` block, or `pull_request_target` workflows that run no agent. Use a workflow linter such as actionlint and zizmor for that.
- **A finding is a pattern match, not proof.** A high finding does not mean a secret has leaked, and a clean audit does not mean the workflow is safe.
- **The scan reads files, not logs.** It looks for secrets and injection traps in the repository, not in the output of a run.

## Related

- [GitHub Action](github-action.md): inputs, outputs, SARIF and code scanning.
- [`zn audit`](audit.md): every rule and how to fix it.
- [Keep secrets out of your agent](secrets.md): the vault, markers and `zn run`.
- [Threat model](threat-model.md): what zn-gate protects against and what it does not.
