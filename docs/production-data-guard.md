# Production data guard

An agent that can run shell commands can also run the ones that delete a database, empty a storage bucket, tear down infrastructure or rewrite a shared branch. Most of the public stories about an agent that "deleted production" follow that pattern: one command, run with the credentials that happened to be on the machine.

The production data guard looks at the shell commands an agent writes **before they run**, and asks you first when a command has one of the shapes below. It is on by default.

It is a guardrail against a model's mistake or a bad suggestion. It reads the text of one command. It is not a sandbox and it does not replace backups, least-privilege credentials or separate accounts for production.

## What it asks about

| Rule | Commands | Examples |
| --- | --- | --- |
| `sql_drop` | `DROP DATABASE`, `DROP SCHEMA`, `DROP TABLE` and `TRUNCATE` sent through a SQL client: `psql` (`-c`, `--command`), `mysql` and `mariadb` (`-e`, `--execute`), `sqlite3` (an argument), `sqlcmd`, `clickhouse-client`, `usql`, and `mongosh` (`--eval` with `dropDatabase()` or a collection `drop()`). Also SQL given on standard input in the same command line: a here-document (`<<EOF`), a here-string (`<<<`), or `echo` and `printf` piped to the client. | `psql -c "DROP DATABASE prod-db-example"`, `mysql -e "TRUNCATE orders"`, `psql prod-db-example <<EOF` followed by `DROP TABLE users;` |
| `terraform_destroy` | `terraform destroy`, `terraform apply -destroy`, and the same with `tofu` and `terragrunt` | `terraform destroy -auto-approve` |
| `kubectl_delete_namespace` | `kubectl delete namespace` (or `ns`), also with `oc` | `kubectl delete namespace prod-example` |
| `kubectl_delete_all` | `kubectl delete` with `--all` | `kubectl delete pods --all -n prod-example` |
| `aws_s3_delete` | `aws s3 rm --recursive`, `aws s3 rb`, `aws s3api delete-bucket`, `aws s3api delete-objects` | `aws s3 rm s3://example-bucket --recursive` |
| `aws_rds_delete` | `aws rds delete-*` (instances, clusters, snapshots) | `aws rds delete-db-instance --db-instance-identifier prod-db-example` |
| `gcloud_delete` | `gcloud` delete of a project, a Cloud SQL instance or database, a storage bucket or a container cluster | `gcloud sql instances delete prod-db-example` |
| `git_force_push_protected` | `git push` with `--force`, `-f`, `--force-with-lease` or a `+ref` to `main`, `master`, `release/*`, or the repository's default branch when it can be read from the repository files | `git push --force origin main` |
| `git_delete_protected_branch` | `git push` that deletes `main`, `master`, `release/*`, or the repository's default branch on a remote: `--delete`, `-d`, or a ref with nothing before the colon (`:main`, `:refs/heads/main`), alone or among several refs | `git push origin --delete main` |

Names in the examples are made up. The guard also reads a command inside `sh -c "..."`, `bash -c`, `eval`, `pwsh -Command` and `cmd /c`, behind `sudo` or `env`, and in a script given to a shell through a here-document.

## What stays allowed

The guard is meant to leave ordinary work alone. These are allowed:

- Text that only mentions a command: `SELECT * FROM users WHERE name = 'DROP TABLE'`, `echo "terraform destroy"`, a commit message, a `grep` for the words.
- Reading and planning: `terraform plan -destroy`, `kubectl get namespaces`, `aws s3 ls`, `aws rds describe-db-instances`, `gcloud sql instances describe ...`, `gcloud projects describe ...`.
- Narrow deletes: `kubectl delete pod web-1`, `kubectl delete -f manifest.yaml`, `aws s3 rm s3://example-bucket/file.txt` (one object, not recursive), `aws s3 rm ... --recursive --dryrun`, `aws s3api delete-object`.
- A SQL here-document that only reads (`SELECT ...`).
- `git push --force` to a feature branch, and a plain `git push origin main` that is not forced.

## What you see

- **Claude Code** (and the other agents whose hooks can ask): you get a question with the reason, for example: "this command is terraform destroy, which deletes every resource the configuration manages. Approve only if the user asked for exactly this and the target is not production data". You approve or refuse it in the agent.
- **Codex CLI and the other agents that cannot show a question** (OpenCode, Gemini CLI, and Cursor's pre-tool hook): the command is **blocked**, not run silently. The reason names the command and the next step: tell the user exactly what was blocked and why; if the user approves it, they can run it themselves outside the agent. The agent is told not to retry the same command on its own.

A command that is blocked or refused does not run. If you want it to run, run it yourself in a terminal.

## Change the setting

Set `hooks.productionDataGuard` in `~/.zn/config.json`:

| Setting | Behaviour |
| --- | --- |
| not set, or `"ask"` | Ask where the agent can ask; block where it cannot (the default) |
| `"deny"` | Block in every agent |
| `"off"` or `false` | The guard is off |

```json
{"hooks": {"productionDataGuard": "deny"}}
```

Strict mode (`{"hooks": {"strict": true}}` or `ZN_STRICT=1`) blocks these commands too. `ZN_PROD_GUARD=deny` makes the guard stricter from the environment. The environment can only raise the level, never lower it: a project an agent works in can set environment variables, so turning the guard off is only possible from the config file, which the agent's file tools cannot write.

The guard applies to the shell tools (Bash, PowerShell and monitors).

## What it does not cover

The guard reads command text only. These are **not** covered, and the guard lets them through:

- **Scripts and programs.** A script the agent wrote and then runs (`python3 reset_db.py`, `./cleanup.sh`, a Makefile target), SQL in a file (`psql -f drop_all.sql`, `psql db < drop_all.sql`), and code that calls a database driver or a cloud SDK (`python3 -c "... cursor.execute('DROP TABLE users')"`). The code inside the file or program is not read.
- **REST and API calls made with a token that was found.** A `curl -X DELETE https://api.example.com/...` with a bearer token, an SDK call, or any request an agent sends with credentials it found on the machine. The guard does not judge network requests; the [egress check](egress-check.md) only looks for personal data and literal secrets in them.
- **Other tools and other cloud services.** Only the commands in the table above. For example `aws dynamodb delete-table`, `gsutil rm -r`, `redis-cli FLUSHALL`, `kubectl delete pv` and `helm uninstall` are not read.
- **Commands that run somewhere else.** `ssh host "terraform destroy"`, a command inside a container, or one that a CI job runs.
- **A program named by a variable** set earlier on the same line, or a command built at run time.
- **A push that names no branch**, when the repository files cannot be read. With no branch name, `git push --force` pushes the current branch; the guard reads the current branch and the default branch from the repository's files (`.git/HEAD` and `refs/remotes/<remote>/HEAD`) and does not run `git`. If they cannot be read, for example in a folder that is not a repository, it allows the command. The default branch is known only when the repository recorded it (a normal `git clone` does).
- **Other cluster and wrapper forms.** `oc delete project`, `xargs terraform destroy`, and a command nested in more than three `sh -c` layers.
- **A folder changed earlier in the same command.** `cd other-repo && git push --force` is read against the folder the agent started in.

For those, use least-privilege credentials, separate accounts or projects for production, backups you have restored at least once, branch protection on the server and your agent's own permission prompts. The guard adds a cheap last check for the most common mistakes; it does not make a command safe.

## False positives

The rules are narrow on purpose, but a command can have a shape the guard asks about and still be what you want, for example `terraform destroy` against a throwaway test environment. Approve it in the agent, or run it yourself. If a rule gets in your way often, set `hooks.productionDataGuard` to `"off"`.

## In your own code

The Node.js check is `checkProductionData(command, { cwd })` from `lib/prod-guard` and the Python one is `check_production_data(command, cwd)` in `zn_gate.prod_guard`. Both return `null` (or `None`) when nothing is found, or an object with the rule, the question for an agent that can ask (`message`) and the text for a block (`deny`). The two implementations share one test corpus, so they find the same commands.
