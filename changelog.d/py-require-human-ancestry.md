### Security
- The Python package has one shared check for commands that only a person at the keyboard may run, the same as the npm package's: it refuses when an agent's environment variable is set, when an AI agent's program is among the parent processes, or when the terminal is not interactive. An agent can remove its variables but not its own process.
