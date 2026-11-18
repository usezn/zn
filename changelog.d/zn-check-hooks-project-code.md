### Fixed
- `zn-gate check --hooks` now reports BROKEN, not OK, for a project hook whose Node.js or zn-gate runner is a file inside the project: the repository could change what the agent runs. The same rule already applied to the audit. A zn-gate installed outside the project is checked as before.
