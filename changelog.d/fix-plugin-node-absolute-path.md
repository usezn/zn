### Security
- The zn-gate plugin hooks for Claude Code start Node.js only from absolute `PATH` entries (through a small `sh` script), so a `node` placed in the project folder, or reached through a relative or empty `PATH` entry, is never run in place of the real Node.js. If no Node.js is found, calls that zn cannot check are blocked, and the other events show a warning.
