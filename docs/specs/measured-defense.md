# Measured defense: from a finding to a re-test with a number

Status: draft spec for a spike. Nothing here is released.

Goal: when a test of your own system finds a weakness, turn it into a defense you can export, then show with a paired comparison on a sealed set that the defense helps and does not cost more false alarms. The text of the attacks stays local; only hashes and labels travel.

## Flow

1. **Finding.** One JSONL row per case, written by the tool that ran the test or by hand: `id`, `surface` (`shell`, `file`, `mcp`, `prompt`), `family` (a public tag, for example an ATT&CK or ATLAS technique id), `label` (`attack` or `benign`), `text_sha256` (hash of the normalized text), `status` (`confirmed` or `dismissed`), `severity`. The text itself stays in a local store.
2. **Split before you write the defense.** Rows are assigned by hash to a *design* part and a *sealed* part before anyone looks at them. Only design rows may be used to write a defense. The sealed part becomes the manifest of `zn-gate eval` and is used once.
3. **Export a defense** from the design rows, in one of three forms:
   - a zn-gate rule (id, pattern or structured condition, verdict, plain reason);
   - a Sigma rule, with the author and the license named, for people who run their own detection;
   - labelled JSONL, for training or for another detector.
4. **Re-test inside `zn-gate eval`.** Pre-register and freeze: the manifest hash, detectors A (before) and B (before plus the defense), the null defender, the gates, the confidence level, the bootstrap settings and the seed. Run once on the sealed part. The report gives TPR and FPR with Wilson intervals, the paired counts, an exact McNemar test, a paired bootstrap interval of the difference, Holm adjustment across the registered comparisons, and PASS or FAIL for each gate.
5. **Decision rule** (registered up front): B is adopted only if the paired gate on attack rows passes (adjusted p below alpha and an interval that excludes zero) and the gate on benign rows shows no increase above a stated margin. A failed run is published the same way as a passed one.

## What exists today

| Piece | State |
|---|---|
| Sealed manifest, pre-registration, freeze, one run per hold-out, paired bootstrap, exact McNemar, Holm, null and block-all controls, hash-chained log, importers for Inspect and AgentDojo results | `zn-gate eval` v0, on a branch, not merged |
| Policy engine with per-call checks (commands, paths, egress, MCP) and a hash-chained evidence log | Released |
| Scope check from a written scope file (hosts, CIDRs, URL prefixes, MCP servers, tools, time window, request limit; deny by default; refusals logged with the hash of the scope file) | This spike |
| Native rule format that can be exported as a rule | Partial: destructive-command rules are data (`lib/destructive.js`); other checks are code |

## What is missing

- A local store for findings with the labels above (confirm, dismiss, severity) and the split by hash.
- A runner that feeds each manifest row to a detector and writes the results file. `zn-gate eval` reads results; it does not run detectors. For the policy engine this is a small adapter that calls the engine on each row's tool call.
- Exporters: zn-gate rule, Sigma with attribution, labelled JSONL.
- Rows for tool-call scope that were written by someone other than the author of the guard (see the limit below).
- Signed scope files and a `verify` command that compares the scope hash in the log with the file in force (the spike has the hash and a library function, no command).

## What the spike shows about tool scope

The engine can express tool scope. It already sees each tool call, parses shell commands, and has a request parser for curl, wget, inline code and MCP arguments. A separate module (`lib/scope/guard.js`) plus an 18-line hook in the pre-tool decision was enough to refuse out-of-scope hosts, addresses, CIDRs, URL parameters that name another host, MCP servers, tools, calls outside a time window and calls over a request limit, and to fail closed on a malformed scope file. 18 tests pass with inert tools and reserved addresses only.

Limits, stated plainly:

- **The check is static.** It reads text. It cannot know what a program does at run time.
- **Scripts.** A script the agent runs by path is read once, one level deep, and judged by the targets it names. A script that builds its target at run time (a variable, a format string, an environment variable, decoded text), reads it from arguments, imports a module that does the request, arrives on standard input, is missing, is binary, or is larger than 256 KB is **unresolved**: refused, or asked if the scope says so. A file can also change between the check and the run.
- **Redirects.** `curl -L` and `wget` without `--max-redirect=0` can end somewhere the check did not see, so they are unresolved unless the scope allows redirects.
- **Not covered:** a bare host name written without a scheme inside a query string, package installs, `make` and package scripts, DNS, and file paths (the spike scopes network targets and tools, not the file system).
- **Over-refusal.** Any URL written in a command is read as a target, so a commit message that mentions an out-of-scope URL is refused.

So the guard is a reliable check for direct calls and a refusal of the unknown for indirect ones. It is not a network boundary. For a hard guarantee, pair it with a control outside the process: an egress proxy or a network with no route out.

## Open questions

- Should the request parser used by the egress check be extended and shared, instead of the guard keeping its own parsers for the programs the egress check does not cover?
- Is JSON enough for the scope file, or do users expect YAML?
