### Security
- `zn team status-report stop` now asks for the same confirmation as `zn team leave`, on the vault's own channel, so an AI agent can no longer silence the status report on its own. It also sends one last report before it stops; if that report cannot be sent, the report still stops and the command says the organization was not told.
