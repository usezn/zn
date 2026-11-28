### Fixed
- zn-gate check no longer writes decision-log records for agents that are not set up, or a second record for an agent whose hook it ran: it adds one block record per agent whose hook it ran, so `zn-gate why` never explains an agent you do not use.
