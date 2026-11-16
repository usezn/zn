### Security
- The Python `check_command` and the destructive-command check in Node.js now read shell code nested up to eight levels deep (`sh -c "sh -c ..."`, `eval`, backticks) and refuse anything deeper instead of skipping it. A dangerous command wrapped in four or more shells was allowed before.
- The Python `check_command`, `evaluate` and the LlamaIndex `check_query` raise `TypeError` for input that is not text instead of allowing it unread. `bytes` are read as UTF-8 and a LlamaIndex `QueryBundle` is read through its `query_str`.
- The Python `sanitize_tool_result` masks secrets in `bytes`, in the attributes of objects and in the text form of objects, not only in strings, lists and dicts.
- The Python `check_tool_result` blocks a result holding an object that cannot be read (rule `type:unscannable`) instead of leaving that part out.
- The OpenAI Agents guardrail blocks a tool call whose `tool_arguments` is missing, instead of allowing it unchecked.
- A generator guarded with `@guard` now has its return value checked and masked, like the values it yields.
