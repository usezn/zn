### Fixed
- The gateway now writes every blocked call to the audit log, counts it in the metrics and sends the webhook alert. Before, only calls denied by the policy engine or the neural check were recorded; calls blocked by the built-in rules, a banned agent, the loop breaker, multi-signature consensus or the image checks were not. The audit entry names the source and the reason of the block.
