### Changed
- The docs and the Python README now say that checkCommand and check_command check destructive shapes only and have no protected-path policy: a command such as copying a credentials file is allowed by them but refused by the agent hooks. They point to checkToolCall and check_tool_call for a text check of sensitive file names.
