### Fixed
- `guardTool`, `checkToolCall` and the result check no longer crash with "Maximum call stack size exceeded" on a payload that holds
  hundreds of thousands of strings. They now return a verdict like the Python package does.
