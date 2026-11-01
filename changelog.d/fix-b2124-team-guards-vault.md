### Security

- zn Team: `zn vault reset`, `zn vault purge` and `zn-gate uninstall` no longer rely only on `team.json` and `org-policy.json` to recognise a machine that belongs to an organization. The vault now also records the organization in its own key file, so deleting those two files with the vault locked does not let a reset or purge through. Leaving an organization still goes through `zn team leave`.
