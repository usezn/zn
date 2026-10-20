### Security
- Copilot CLI (experimental): the install now warns that Copilot lets no hook change or block the result of a failed tool call, so a secret printed by a command that then fails reaches the model; the docs state the limit. Failed results are never reported as successful.
