### Security
- The gateway masks secrets in the policy or refusal text of a webhook alert, the same way it already does for the audit database and the event stream. A raw tool name or agent id taken from a message can no longer reach a webhook.
