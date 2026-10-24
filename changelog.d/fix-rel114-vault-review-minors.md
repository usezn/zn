### Security
- When the vault unlocks after an unclean shutdown and takes over audit records that were written but not yet checkpointed, it now writes a `warn` record (`audit_tail_adopted_after_unclean_shutdown`) so every crash is visible in `zn vault log`.
