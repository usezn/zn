### Security
- `zn audit` reports a project that sets `LD_TRACE_LOADED_OBJECTS`, or `LD_DEBUG=help`, for the agent as critical. On Linux
  these variables make the system stop every program the agent starts before it runs, the shell of each zn hook included, so
  the hooks cannot check or block anything. No hook can refuse them from inside; the threat model now says which agents
  let such calls go ahead.
