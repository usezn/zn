### Added
- `guarded_tool` in the Python package takes `on_block_callback(assessment, name, payload)`, like `onBlockCallback` in the Node `guardTool`. It is called before a block is applied, for blocked arguments and blocked results, in sync and async tools. If the callback raises, its exception propagates and the call is not allowed through.
