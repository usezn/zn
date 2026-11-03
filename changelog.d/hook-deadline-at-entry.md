### Fixed
- The time limit of the check on tool output after a tool has run now starts when the hook receives the event, not when the check begins. Time spent reading and preparing the event now counts, so the hook still answers before the agent's own hook timeout.
