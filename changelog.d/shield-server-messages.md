### Security
- `zn-gate shield` now checks the other text a server sends to the agent, not only tool results: notifications, requests such as sampling, resource and prompt contents, and error messages. Text that carries an injection is replaced by a notice, and secrets are redacted. Shadow mode still only reports.
