# Example: Python API

Five short examples of the Python package. All values are fake. For every argument, return value and limit, read the [full API reference](../api-reference.md#python-zn-gate).

## Evaluate a text

`evaluate` is local and deterministic and never touches the network. `verdict` is `'allow'` or `'block'`.

```python
from zn_gate import evaluate

assessment = evaluate("Please summarize the notes in /tmp/example.txt")
print(assessment.verdict, assessment.allowed)
print(assessment.to_dict())
```

## Check a shell command

`check_command` checks shell text for destructive commands. When it blocks, `rule` is something like `destructive:rm_root_home`. See [Destructive commands](../destructive-commands.md).

```python
from zn_gate import check_command

assessment = check_command("ls -la /tmp/example")
print(assessment.verdict, assessment.rule)
```

## Check a tool call

`check_tool_call` inspects every string in the arguments, including nested values and keys.

```python
from zn_gate import check_tool_call

assessment = check_tool_call("run_tool", {"command": "echo hello", "cwd": "/tmp/example"})
print(assessment.verdict, assessment.reason)
```

## Log an evidence record

`log_evidence` appends one hash-chained record to the evidence log. It returns the record, or `None` when nothing was written. Here the log is a file under `/tmp/example`.

```python
from zn_gate import log_evidence

record = log_evidence({"tool": "run_tool", "verdict": "allow"}, file_path="/tmp/example/evidence.jsonl")
print(record is not None)
```

## Verify the evidence log

`verify_evidence_ledger` checks the chain and returns `{'valid', 'total', 'verified', 'broken_index', 'error'}`.

```python
from zn_gate import verify_evidence_ledger

result = verify_evidence_ledger("/tmp/example/evidence.jsonl")
print(result["valid"], result["total"], result["verified"])
```
