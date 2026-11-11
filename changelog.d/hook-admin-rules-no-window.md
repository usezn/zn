### Security
- The hooks now refuse the commands that only the user may run (`zn-gate audit --approve`, `zn-gate evidence --accept`, `zn vault verify --acknowledge`) when the flag comes after a very long run of other arguments, as they do for a short command. The check reads the whole command instead of a limited stretch of it.
