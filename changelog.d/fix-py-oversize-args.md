### Fixed
- In the Python package, `check_tool_call` now blocks arguments over the 4 MB scan limit (rule `size:oversize`), like the npm package, instead of letting them through marked as truncated.
