### Security
- The Antigravity hook now checks agent-management tools it used to let through. Text sent to a running terminal with `manage_task` (`send_input`) gets the same checks as a shell command, and `schedule` and `define_subagent` always ask for confirmation.
