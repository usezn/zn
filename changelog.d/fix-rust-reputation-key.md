### Security
- The gateway no longer lets a client start clean by changing or leaving out its agent id. Bans, violations and the loop breaker are now kept per namespace and connection, a ban earned on one connection holds for the whole namespace until it ends, and a namespace accepts at most 256 distinct agent ids (`security.max_agent_ids_per_namespace`); a new id past the cap is denied.
