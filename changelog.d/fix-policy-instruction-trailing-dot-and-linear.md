### Security
- On Windows, a write to an agent instruction file spelled with trailing dots or spaces (for example `AGENTS.md.`, a file that does not exist yet) is now reviewed like the plain name, and so is a new instruction file written under its 8.3 short name (for example `AGENTS~1.MD`).
- The check for writes into the `.agents` hook folder now takes time linear in the command, so a command of many long words can no longer slow the hook.
